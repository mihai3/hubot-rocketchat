import { Adapter, Response, TextMessage, EnterMessage, LeaveMessage } from 'hubot'
import { Rocketchat } from './vendor/rocketchat-sdk.mjs'

/** The message stream the bot subscribes to: every message in every room
 *  the bot user is a member of, as the server defines `__my_messages__`. */
const MESSAGE_STREAM = 'stream-room-messages'
const MESSAGE_STREAM_NAME = '__my_messages__'

/** Default connection timeout, in ms */
const DEFAULT_TIMEOUT = 20 * 1000

/** Adapter settings, read once from the environment */
const settings = {
  username: process.env.ROCKETCHAT_USER || 'bot',
  password: process.env.ROCKETCHAT_PASSWORD || 'pass',
  ldap: process.env.ROCKETCHAT_AUTH === 'ldap',
  host: (process.env.ROCKETCHAT_URL || 'localhost:3000').replace(/(^\w+:|^)\/\//, ''),
  useSsl: /^true$/i.test(process.env.ROCKETCHAT_USE_SSL || ''),
  timeout: DEFAULT_TIMEOUT,
  rooms: (process.env.ROCKETCHAT_ROOM || '').split(',').map((room) => room.trim()).filter(Boolean),
  allPublic: (process.env.LISTEN_ON_ALL_PUBLIC || 'false').toLowerCase() === 'true',
  dm: (process.env.RESPOND_TO_DM || 'false').toLowerCase() === 'true',
  livechat: (process.env.RESPOND_TO_LIVECHAT || 'false').toLowerCase() === 'true',
  edited: (process.env.RESPOND_TO_EDITED || 'false').toLowerCase() === 'true',
  integrationId: process.env.INTEGRATION_ID || 'js.SDK'
}

/** Extend default response with custom adapter methods */
class RocketChatResponse extends Response {
  sendDirect (...strings) {
    this.robot.adapter.sendDirect(this.envelope, ...strings)
  }

  sendPrivate (...strings) {
    this.robot.adapter.sendDirect(this.envelope, ...strings)
  }
}

/** Define new message type for handling attachments */
class AttachmentMessage extends TextMessage {
  constructor (user, attachment, text, id) {
    super(user, text, id)
    this.user = user
    this.attachment = attachment
    this.text = text
    this.id = id
  }

  toString () {
    return this.attachment
  }
}

/** Main API for Hubot on Rocket.Chat */
class RocketChatBotAdapter extends Adapter {
  constructor (robot) {
    super(robot)
    this.lastReadTime = new Date()
  }

  run () {
    this.robot.logger.info('[startup] Rocket.Chat adapter in use')

    // Print logs with current configs
    this.robot.logger.info(`[startup] Respond to name: ${this.robot.name}`)
    this.robot.alias = (this.robot.name === settings.username || this.robot.alias)
      ? this.robot.alias
      : settings.username
    if (this.robot.alias) {
      this.robot.logger.info(`[startup] Respond to alias: ${this.robot.alias}`)
    }

    // Overwrite Robot's response class with Rocket.Chat custom one
    this.robot.Response = RocketChatResponse

    // The REST host needs a scheme; the realtime driver strips it itself
    const host = `${settings.useSsl ? 'https' : 'http'}://${settings.host}`

    // Wrap the robot's logger, as the SDK logger interface wants a
    // `warning` alias and must never throw
    const logger = {
      debug: (...args) => this.robot.logger.debug(...args),
      info: (...args) => this.robot.logger.info(...args),
      warn: (...args) => this.robot.logger.warn(...args),
      warning: (...args) => this.robot.logger.warn(...args),
      error: (...args) => this.robot.logger.error(...args)
    }

    // The SDK client covers both REST (api) and realtime (driver) sides
    this.sdk = new Rocketchat({ host, useSsl: settings.useSsl, timeout: settings.timeout, integration: settings.integrationId, logger })
    this.api = this.sdk
    this.driver = this.sdk.driver

    // Make the adapter's settings available to scripts, via `adapter.`
    this.settings = settings

    this.connect()
      .then(() => this.login())
      .then(() => this.joinRooms())
      .then(() => this.subscribe())
      .then(() => {
        this.emit('connected') // tells hubot to load scripts
      })
      .catch((err) => {
        this.robot.logger.error(`Unable to connect: ${JSON.stringify(err)}`)
      })
  }

  /** Connect the realtime driver */
  async connect () {
    return this.sdk.connect()
  }

  /** Login via the REST API, then resume the session on the driver */
  async login () {
    const credentials = settings.ldap
      ? { ldap: true, username: settings.username, ldapPass: settings.password }
      : { username: settings.username, password: settings.password }
    const login = await this.sdk.login(credentials)
    this.robot.logger.info(`[startup] Logged in as ${login?.id ?? this.sdk.userId}`)
    return login
  }

  /** Join all rooms from the room setting (single name or comma separated) */
  async joinRooms () {
    for (const room of settings.rooms) {
      try {
        const rid = await this.sdk.getRoomIdByNameOrId(room)
        await this.sdk.methodCall('joinRoom', rid)
        this.joinedIds = [...(this.joinedIds || []), rid]
        this.robot.logger.info(`[startup] Joined room: ${room}`)
      } catch (err) {
        this.robot.logger.error(`[joinRooms] Failed to join configured room (${room}): ${JSON.stringify(err)}`)
      }
    }
  }

  /**
   * Subscribe to the bot user's message stream and attach the reactive
   * callback which processes every message update
   */
  async subscribe () {
    this.lastReadTime = new Date() // init before any message read
    await this.sdk.subscribeRaw(MESSAGE_STREAM, [MESSAGE_STREAM_NAME])
    return this.sdk.driver.onStreamData(MESSAGE_STREAM, (frame) => {
      try {
        this.process(frame)
      } catch (err) {
        this.robot.logger.error(`[received] Unable to process: ${err.message}`)
      }
    })
  }

  /** Process every incoming message in the subscription */
  process (frame) {
    const args = frame?.fields?.args || []
    const message = args[0]
    const meta = args[1] || {}
    if (!message) return

    // Normalize the message timestamp, EJSON encoded on the wire
    if (typeof message.ts?.$date !== 'undefined') {
      message.ts = { $date: message.ts.$date }
    }

    // Ignore bot's own messages
    if (this.sdk && message.u?._id === this.sdk.userId) return

    // Collect required attributes from message meta
    const isDM = (meta.roomType === 'd')
    const isLC = (meta.roomType === 'l')

    // Ignore DMs unless configured not to
    if (isDM && !settings.dm) return

    // Ignore Livechat unless configured not to
    if (isLC && !settings.livechat) return

    // Ignore messages in un-joined public rooms unless configured not to
    if (!settings.allPublic && !isDM && !isLC && !meta.roomParticipant) return

    // Set current time for comparison to incoming
    let currentReadTime = new Date(message.ts?.$date ?? message.ts)

    // Ignore edited messages if configured to
    if (!settings.edited && message.editedAt) return

    // Set read time as time of edit, if message is edited
    if (message.editedAt) currentReadTime = new Date(message.editedAt.$date ?? message.editedAt)

    // Ignore messages in stream that aren't new
    if (currentReadTime <= this.lastReadTime) return

    // At this point, message has passed checks and can be received
    this.lastReadTime = currentReadTime
    this.robot.logger.info(`[received] Message ${message._id} from ${message.u.username}`)
    return this.receiveMessage(message, meta)
  }

  /** Prepare message type for Hubot to receive */
  receiveMessage (message, meta) {
    const user = this.robot.brain.userForId(message.u._id, {
      name: message.u.username,
      alias: message.alias
    })
    user.roomID = message.rid
    user.roomType = meta.roomType
    user.room = meta.roomName || message.rid

    // Room joins, receive without further detail
    if (message.t === 'uj') {
      this.robot.logger.debug('Message type EnterMessage')
      return this.robot.receive(new EnterMessage(user, null, message._id))
    }

    // Room exit, receive without further detail
    if (message.t === 'ul') {
      this.robot.logger.debug('Message type LeaveMessage')
      return this.robot.receive(new LeaveMessage(user, null, message._id))
    }

    // Direct messages prepend bot's name so Hubot can `.respond`
    const startOfText = (message.msg.indexOf('@') === 0) ? 1 : 0
    const robotIsNamed = message.msg.indexOf(this.robot.name) === startOfText || message.msg.indexOf(this.robot.alias) === startOfText
    if ((meta.roomType === 'd' || meta.roomType === 'l') && !robotIsNamed) message.msg = `${this.robot.name} ${message.msg}`

    // Attachments, format properties for Hubot
    if (Array.isArray(message.attachments) && message.attachments.length) {
      const attachment = message.attachments[0]
      if (attachment.image_url) {
        attachment.link = `http${settings.useSsl ? 's' : ''}://${settings.host}${attachment.image_url}`
        attachment.type = 'image'
      } else if (attachment.audio_url) {
        attachment.link = `http${settings.useSsl ? 's' : ''}://${settings.host}${attachment.audio_url}`
        attachment.type = 'audio'
      } else if (attachment.video_url) {
        attachment.link = `http${settings.useSsl ? 's' : ''}://${settings.host}${attachment.video_url}`
        attachment.type = 'video'
      }
      this.robot.logger.debug('Message type AttachmentMessage')
      return this.robot.receive(new AttachmentMessage(user, attachment, message.msg, message._id))
    }

    // Standard text messages, receive as is
    const textMessage = new TextMessage(user, message.msg, message._id)
    this.robot.logger.debug(`TextMessage: ${textMessage.toString()}`)
    return this.robot.receive(textMessage)
  }

  /** Send messages to user addressed in envelope */
  async send (envelope, ...strings) {
    return Promise.all(strings.map(async (text) => {
      if (envelope.user && envelope.user.roomID) return this.sdk.sendMessage(text, envelope.user.roomID)
      const rid = await this.getRoomId(envelope.room)
      return this.sdk.sendMessage(text, rid)
    }))
  }

  /**
   * Emote message to user
   * @todo Improve this legacy method
   */
  async emote (envelope, ...strings) {
    return this.send(envelope, ...strings.map((text) => `_${text}_`))
  }

  /** Send custom message to user */
  async customMessage (data) {
    const { rid, ...message } = data
    return this.sdk.sendMessage(message, rid)
  }

  /** Send DM to user */
  async sendDirect (envelope, ...strings) {
    return Promise.all(strings.map(async (text) => {
      const room = await this.sdk.createDirectMessage(envelope.user.name)
      return this.sdk.sendMessage(text, room._id)
    }))
  }

  /** Reply to a user's message (mention them if not a DM) */
  async reply (envelope, ...strings) {
    if (envelope.room.indexOf(envelope.user.id) === -1) {
      strings = strings.map((s) => `@${envelope.user.name} ${s}`)
    }
    return this.send(envelope, ...strings)
  }

  /** Get a room ID via the REST api */
  getRoomId (room) {
    return this.sdk.getRoomIdByNameOrId(room)
  }

  /** Call a server method via the realtime driver */
  callMethod (method, ...args) {
    return this.sdk.methodCall(method, ...args)
  }
}

export default {
  use: (robot) => new RocketChatBotAdapter(robot)
}
