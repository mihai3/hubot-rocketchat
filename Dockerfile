FROM node:22

MAINTAINER Rocket.Chat Team <buildmaster@rocket.chat>

RUN npm install -g npm@9 && \
	useradd hubot -m

USER hubot

WORKDIR /home/hubot

ENV BOT_NAME "rocketbot"
ENV BOT_OWNER "No owner specified"
ENV BOT_DESC "Hubot with rocketbot adapter"
ENV HUBOT_LOG_LEVEL "error"

ENV EXTERNAL_SCRIPTS=hubot-diagnostics,hubot-help

# Create a minimal ESM hubot project for the bot
RUN npm init -y && \
	npm pkg set type=module && \
	echo "[]" > external-scripts.json && \
	mkdir -p scripts

ADD . /home/hubot/node_modules/hubot-rocketchat

# hack added to get around owner issue: https://github.com/docker/docker/issues/6119
USER root
RUN chown hubot:hubot -R /home/hubot/node_modules/hubot-rocketchat
USER hubot

RUN cd /home/hubot && \
	npm install hubot@14 hubot-rocketchat@file:./node_modules/hubot-rocketchat && \
	echo "export default (robot) => {}" > scripts/placeholder.mjs

CMD node_modules/.bin/hubot -n $BOT_NAME -a hubot-rocketchat
