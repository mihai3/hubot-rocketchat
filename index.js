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
  host: (process.env.ROCKETCHAT_URL || 'localhost:3000').replace(/^\w+:\/\//, ''),
  // Enable SSL by default if the Rocket.Chat URL contains https, as the
  // 0.2.x SDK did; ROCKETCHAT_USE_SSL=true|false overrides explicitly
  useSsl: (process.env.ROCKETCHAT_USE_SSL)
    ? (process.env.ROCKETCHAT_USE_SSL.toLowerCase() === 'true')
    : (process.env.ROCKETCHAT_URL || '').toLowerCase().startsWith('https'),
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

  /** Upload a file to the room this response belongs to (rooms.media) */
  upload (buffer, filename, message) {
    return uploadFile(this.robot.adapter, this.message.user.roomID, buffer, filename, message)
  }

  /** React to the message this response belongs to (chat.react) */
  react (emoji, shouldReact = true) {
    return reactToMessage(this.robot.adapter, this.message.id, emoji, shouldReact)
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

    // Convenience wrappers for scripts, available as `robot.`
    this.robot.fetchAttachment = (attachmentOrUrl) => fetchAttachmentData(this, attachmentOrUrl)
    this.robot.react = (messageId, emoji, shouldReact = true) => reactToMessage(this, messageId, emoji, shouldReact)
    // Room id variant: res-based upload resolves the room when called, which
    // can go stale across awaits in the listener
    this.robot.upload = (roomId, buffer, filename, message = '') => uploadFile(this, roomId, buffer, filename, message)

    this.connect()
      .then(() => this.login())
      .then(() => this.joinRooms())
      .then(() => this.subscribe())
      .then(() => {
        this.emit('connected') // tells hubot to load scripts
      })
      .catch((err) => {
        this.robot.logger.error({ err, cause: err.cause ? { code: err.cause.code, message: err.cause.message ?? String(err.cause) } : undefined }, 'Unable to connect')
      })
      .finally(() => {
        // From here on, recover from connection drops. The SDK reopens the
        // transport after an unexpected close (e.g. code 1006), but neither
        // re-logs-in nor re-subscribes, which would leave the bot deaf on
        // the new (unauthenticated) session. Redo both on every reconnect.
        this.ready = true
        this.sdk.driver.on('connected', () => {
          if (!this.ready) return // initial connect is handled by the chain above
          this.ready = false
          this.robot.logger.info('[reconnect] Re-authenticating and resubscribing')
          this.login()
            .then(() => this.subscribe())
            .catch((err) => this.robot.logger.error({ err, cause: err.cause ? { code: err.cause.code, message: err.cause.message ?? String(err.cause) } : undefined }, '[reconnect] Failed to recover'))
            .finally(() => {
              this.ready = true
              this.emit('connected')
            })
        })
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
    // init before any message read; preserved across reconnects so messages
    // missed during a connection outage are still processed afterwards
    if (!this.lastReadTime) this.lastReadTime = new Date()
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
      const base = `http${settings.useSsl ? 's' : ''}://${settings.host}`
      for (const kind of ['image', 'audio', 'video']) {
        const url = attachment[`${kind}_url`]
        if (url) {
          // Only prefix relative paths; absolute URLs are left untouched
          attachment.link = /^https?:\/\//i.test(url) ? url : `${base}${url.startsWith('/') ? '' : '/'}${url}`
          attachment.type = kind
          break
        }
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

  /**
   * REST call with a normalized argument order. The SDK's `request`
   * takes an `ignore` RegExp before `options`; routing every
   * options-bearing call through here avoids that trap.
   */
  apiCall (method, endpoint, data = {}, options = {}) {
    return this.sdk.request(String(method).toUpperCase(), endpoint, data, undefined, options)
  }

/**
 * REST call with a normalized argument order. The SDK's `request`
 * takes an `ignore` RegExp before `options`; routing every
 * options-bearing call through here avoids that trap.
 */
apiCall (method, endpoint, data = {}, options = {}) {
  return this.sdk.request(String(method).toUpperCase(), endpoint, data, undefined, options)
}
}

/** Ensure a REST session exists, logging in with the configured credentials if not */
async function ensureLogin (adapter) {
  if (adapter.sdk.loggedIn()) return
  const credentials = settings.ldap
    ? { ldap: true, username: settings.username, ldapPass: settings.password }
    : { username: settings.username, password: settings.password }
  return adapter.sdk.loginWithRest(credentials)
}

/**
 * Upload a file to a room, posting it as a message with an optional
 * description. `buffer` may be a Buffer, Uint8Array, or Blob. Uploads
 * the file via rooms.media, then confirms it (which posts the message)
 * via rooms.mediaConfirm. Returns the confirm response (containing the
 * created message).
 */
async function uploadFile (adapter, rid, buffer, filename, message = '') {
  await ensureLogin(adapter)
  const form = new FormData()
  form.append('file', new Blob([buffer]), filename)
  // Pass the auth headers explicitly: the SDK client would otherwise add
  // a Content-Type: application/json header, which corrupts multipart bodies
  const { 'X-Auth-Token': token, 'X-User-Id': userId } = adapter.sdk.client.headers
  const uploaded = await adapter.apiCall('POST', `rooms.media/${rid}`, form, { customHeaders: { 'X-Auth-Token': token, 'X-User-Id': userId } })
  const fileId = uploaded?.file?._id ?? uploaded?.message?.file?._id
  if (!fileId) throw new Error(`File upload did not return a file id: ${JSON.stringify(uploaded)}`)
  return adapter.apiCall('POST', `rooms.mediaConfirm/${rid}/${fileId}`, { msg: '', description: message || '' })
}

/**
 * React to a message. `emoji` is the reaction name, with or without
 * colons (e.g. 'tada' or ':tada:'), or a unicode emoji. Pass
 * `shouldReact` as false to remove the reaction.
 */
async function reactToMessage (adapter, messageId, emoji, shouldReact = true) {
  await ensureLogin(adapter)
  return adapter.apiCall('POST', 'chat.react', { messageId, emoji, shouldReact })
}

/**
 * Download an attachment and return it as a Buffer. Accepts an
 * attachment object as delivered on AttachmentMessage (with a `link`
 * property) or a plain URL (absolute, or relative to the Rocket.Chat
 * server). The bot's credentials are sent as auth headers, so files
 * in private rooms can be fetched too.
 */
async function fetchAttachmentData (adapter, attachmentOrUrl) {
  await ensureLogin(adapter)
  const base = `http${settings.useSsl ? 's' : ''}://${settings.host}`
  let url = typeof attachmentOrUrl === 'string' ? attachmentOrUrl : attachmentOrUrl?.link
  if (!url) throw new Error('No attachment URL provided')
  if (!/^https?:\/\//i.test(url)) url = `${base}${url.startsWith('/') ? '' : '/'}${url}`
  const res = await fetch(url, { headers: { ...adapter.sdk.client.headers } })
  if (!res.ok) throw new Error(`Failed to download attachment: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

export default {
  use: (robot) => new RocketChatBotAdapter(robot)
}
