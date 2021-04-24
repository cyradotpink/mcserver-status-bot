#!/usr/bin/env node

const DiscordClient = require('./discordclient/DiscordClient')
const fs = require('fs')
const https = require('https')
const getServerStatus = require('./getServerStatus')
const path = require('path')
const process = require('process')

var state = {
    messages: {},
    session: {
        id: null,
        sequence: null
    },
    token: null
}
try {
    state = JSON.parse(fs.readFileSync('state.json').toString())
} catch (err) {}
if (process.argv[2]) state.token = process.argv[2]
const saveState = () => {
    fs.promises.writeFile(__dirname + '/../state.json', JSON.stringify(state))
}
saveState()

if (!state.token) throw new Error('No token')

const intervals = {}

const bot = new DiscordClient(state.token, state.session.id, state.session.sequence)

bot.gatewaySocket.subToOpcode([0], (msg) => {
    state.session.id = bot.gatewaySocket.sessionId
    state.session.sequence = bot.gatewaySocket.sequence
    saveState()
})

const createStatusMessage = (statusObj) => {
    console.log(statusObj)
    if (!statusObj.players.sample) statusObj.players.sample = []
    var playerList = statusObj.players.sample
        .map(val => `- ${val.name}`)
        .sort()
        .join('\n')
    return {
        embed: {
            title: statusObj.description.text,
            color: 0xEA02BC,
            fields: [{
                name: 'Player count',
                value: `${statusObj.players.online}`
            }, {
                name: 'Players',
                value: playerList || 'None'
            }]
        }
    }
}

const createStatusFailMessage = (serverName) => {
    return {
        embed: {
            title: statusObj.description.text,
            color: 0xEA02BC,
            description: 'An error occured'
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
        updateMsg = createStatusMessage(serverStatus)
    } catch (err) {
        console.log('When trying to get server status', err)
        updateMsg = createStatusFailMessage(msgState.lastState.description.text)
    }
    if (updateMsg.embed.fields[1].value === msgState.lastUpdateMessage.embed.fields[1].value) {
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
            content: 'Something went wrong.'
        }).catch((err) => {
            console.log('When trying to send error message', err)
        })
        return
    }
    try {
        var updateMsg = createStatusMessage(serverStatus)
        console.log(updateMsg.embed.fields)
        var newMessage = await bot.request('POST', `/channels/${msgData.channel_id}/messages`, updateMsg)
        console.log(newMessage)
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
            content: 'Something went wrong.'
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