#!/usr/bin/env node

'use strict'

const DiscordClient = require('./DiscordClient')
const fs = require('fs')
const https = require('https')
const getServerStatus = require('./getServerStatus')
const path = require('path')
const process = require('process')


var configPath
var config
try {
    configPath = path.resolve(process.argv[2])
    config = JSON.parse(fs.readFileSync(configPath).toString())
} catch (err) {
    console.error(err)
    throw new Error('Configuration could not be loaded.')
}

var statePath = config.statePath ||
    (() => { throw new Error('No state path provided') })()
if (!path.isAbsolute(statePath))
    statePath = path.normalize(path.dirname(configPath) + '/' + statePath)

var botToken = config.botToken ||
    (() => { throw new Error('No bot token provided') })()

console.log(`Configured with:\nToken: ${botToken}\nState path: ${statePath}`)

// throw new Error('test')

var state = {
    messages: {},
    session: {
        id: null,
        sequence: null
    }
}
try {
    state = JSON.parse(fs.readFileSync(statePath).toString())
} catch (err) {}
const saveState = () => {
    fs.promises.writeFile(statePath, JSON.stringify(state))
}
saveState()

const intervals = {}

const bot = new DiscordClient(botToken, state.session.id, state.session.sequence)

const compareObjects = (a, b) =>
    JSON.stringify(a) === JSON.stringify(b)

const createStatusMessage = (statusObj, ip) => {
    if (!statusObj.players.sample) statusObj.players.sample = []
    var playerList = statusObj.players.sample
        .map(val => `• ${val.name}`)
        .sort()
        .join('\n')
    return {
        embed: {
            title: statusObj.description.text,
            description: `\`${ip}\``,
            color: 0xEA02BC,
            fields: [{
                name: 'Version',
                value: `${statusObj.version.name}`,
                inline: true
            }, {
                name: 'Online',
                value: `${statusObj.players.online} / ${statusObj.players.max}`,
                inline: true
            }, {
                name: 'Players',
                value: playerList || 'None',
                inline: false
            }]
        }
    }
}

const createStatusFailMessage = (serverName, ip) => {
    return {
        embed: {
            title: serverName,
            color: 0xEA02BC,
            description: `\`${ip}\`\n[An error occured]`
        }
    }
}

const stopUpdating = (msgId) => {
    try {
        clearInterval(intervals[msgId])
    } catch (err) {
        console.log('When trying to clear interval', err)
    }
    delete intervals[msgId]
    delete state.messages[msgId]
    saveState()
}

const doUpdate = async(messageId) => {
    var msgState = state.messages[messageId]
    var updateMsg = {}
    var serverStatus
    try {
        serverStatus = await getServerStatus(msgState.host, msgState.port)
        updateMsg = createStatusMessage(serverStatus, `${msgState.host}:${msgState.port}`)
    } catch (err) {
        console.log('When trying to get server status', err)
        updateMsg = createStatusFailMessage(msgState.lastState.description.text, `${msgState.host}:${msgState.port}`)
    }
    if (compareObjects(updateMsg, msgState.lastUpdateMessage)) {
        return
    }
    state.messages[messageId].lastState = serverStatus
    state.messages[messageId].lastUpdateMessage = updateMsg
    saveState()
    console.log('Updating some status')
    try {
        var msgEdit = await bot.request('PATCH', `/channels/${msgState.channelId}/messages/${msgState.msgId}`, updateMsg)
        if (msgEdit.status === 404) {
            console.log('Message was deleted. Discontinuing updates.')
            stopUpdating(msgState.msgId)
        }
    } catch (err) {
        console.log('When trying to update message', err)
    }
}

const startUpdates = (messageId) => {
    intervals[messageId] = setInterval(() => {
        doUpdate(messageId)
    }, 20000)
}

const newWatchHandler = async(msgData, groups) => {
    var serverStatus
    try {
        serverStatus = await getServerStatus(groups.host, parseInt(groups.port))
    } catch (err) {
        console.log('When trying to get server status', err)
        bot.request('POST', `/channels/${msgData.channel_id}/messages`, {
            content: 'Something went wrong :/'
        }).catch((err) => {
            console.log('When trying to send error message', err)
        })
        return
    }
    try {
        var updateMsg = createStatusMessage(serverStatus, `${groups.host}:${groups.port}`)
        var newMessage = await bot.request('POST', `/channels/${msgData.channel_id}/messages`, updateMsg)
        if (newMessage.status !== 200) throw new Error('Non-200 status')
        state.messages[newMessage.data.id] = {
            host: groups.host,
            port: parseInt(groups.port),
            msgId: newMessage.data.id,
            channelId: newMessage.data.channel_id,
            lastState: serverStatus,
            lastUpdateMessage: updateMsg
        }
        saveState()
        startUpdates(newMessage.data.id)
    } catch (err) {
        bot.request('POST', `/channels/${msgData.channel_id}/messages`, {
            content: 'Something went wrong :/'
        }).catch((err) => {
            console.log('When trying to send error message', err)
        })
        console.log('When trying to create new message', err)
        return
    }
}

const stopWatchingHandler = async(msgData, groups) => {
    if (state.messages[groups.msgid]) {
        var msgId = groups.msgid
        var channelId = state.messages[msgId].channelId
        stopUpdating(msgId)
        var deletion = await bot.request('DELETE', `/channels/${channelId}/messages/${msgId}`)

        // console.log(deletion)
    }
}

const main = async() => {
    await bot.awaitInit
    console.log('Waited for init')

    bot.gatewaySocket.subToOpcode([0], (msg) => {
        state.session.id = bot.gatewaySocket.sessionId
        state.session.sequence = bot.gatewaySocket.sequence
        saveState()
    })

    state.session.id = bot.gatewaySocket.sessionId
    state.session.sequence = bot.gatewaySocket.sequence
    saveState()

    Object.values(state.messages).forEach(val => {
        doUpdate(val.msgId)
        startUpdates(val.msgId)
    })

    const commandHandlers = [{
        regex: /!!watchmcserver +(?<host>[^:]+):(?<port>\d+)\b/,
        handler: newWatchHandler
    }, {
        regex: /!!stopwatching +(?<msgid>\d+)\b/,
        handler: stopWatchingHandler
    }]
    bot.gatewaySocket.subToEvent(['MESSAGE_CREATE'], async(msg) => {
        for (let cmdHandler of commandHandlers) {
            var match = msg.data.content.match(cmdHandler.regex)
            if (match) {
                console.log('Handling', cmdHandler.regex.toString().slice(1).split(' ')[0])
                setImmediate(async() => {
                    try {
                        await cmdHandler.handler(msg.data, match.groups)
                    } catch (err) {
                        console.log('When trying to handle command', err)
                    }
                })
                break
            }
        }
    })
}

main()