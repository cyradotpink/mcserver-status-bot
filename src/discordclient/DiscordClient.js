'use strict'

const https = require('https')
const http = require('http')
const crypto = require('crypto')
const WebSocket = require('ws')


// I don't really use response cookies in this project but ya know
const parseCookie = (cookie) => {
    const argsSplit = cookie.split('; ');
    const paramsDict = {};
    argsSplit.slice(1).forEach((keyVal) => {
        var keyValSplit = keyVal.split('=');
        paramsDict[keyValSplit[0]] = keyValSplit[1] ? keyValSplit[1] : '';
    });
    return {
        key: argsSplit[0].split('=')[0],
        value: argsSplit[0].split('=')[1],
        params: paramsDict
    }
}


// I copy paste this small http request helper into basically every one of my projects
const httpReq = (options, data = '', secure = true) => {
    return new Promise((resolve, reject) => {
        if (data && typeof options === 'object') {
            if (!options.headers) options.headers = {}
            options.headers['content-length'] = Buffer.byteLength(data).toString()
        }
        const httpVariant = secure ? https : http
        var req = httpVariant.request(options, (res) => {
            var data = ''
            res.on('error', (err) => {
                reject(err)
            })
            res.on('data', (d) => {
                data += d
            })
            res.on('end', () => {
                var cookieSets = res.headers['set-cookie']
                var parsedCookies = []
                if (Array.isArray(cookieSets)) {
                    parsedCookies = cookieSets.map(cookieSet => parseCookie(cookieSet))
                } else if (cookieSets) {
                    parsedCookies = [parseCookie(cookieSets)]
                }
                resolve({
                    'data': data,
                    'status': res.statusCode,
                    'headers': res.headers,
                    'cookies': parsedCookies
                })
            })
        })
        req.write(data)
        req.on('error', (err) => {
            reject(err)
        })
        req.on('timeout', () => {
            reject(new Error('Timeout'))
        })
        req.end()
    })
}

/**
 * Manages the connection the Discord API "gateway" socket (https://canary.discord.com/developers/docs/topics/gateway)
 * @param {string} token Bot token
 * @param {string} resumeSession Session ID to attempt to resume
 */
const GateWaySocket = class {
    constructor(token, resumeSession = null, resumeSequence = 0) {
        this.sessionId = resumeSession
        this.token = token
        this.sequence = resumeSequence
        this.isInit = false

        // Immediately respond to all heartbeat requests
        this.subToOpcode([1], (msg) => {
            console.log('Gateway asked for heartbeat')
            this.sendMessage(1)
        })

        // Re-initialise if gateway signals invalid session
        this.subToOpcode([9], (msg) => {
            console.log('Invalid session')
            this.sessionId = null
            setImmediate(() => {
                this.init()
            })
        })

        // Promise which resolves when initalisation is complete
        this.awaitInit = new Promise((resolve, reject) => {
            this.signalInit = () => {
                console.log('Signaling init success')
                resolve()
            }
            setImmediate(() => {
                this.init()
            })
        }).then((res) => {
            this.isInit = true
        })
    }

    async init() {
        if (this._ws) this._ws.close()
        this._ws = new WebSocket('wss://gateway.discord.gg/?v=8&encoding=json')
        this._ws.on('message', msg => this.handleMsg(msg))

        var hello = await this.awaitOneOpCode(10)
        console.log('Gateway says hello')

        // Subscribe to heartbeat acknowledgements, send heartbeats with the requested interval length,
        // Re-initialise if an old heartbeat is not acknowledged when a new heartbeat is about to be sent
        if (this._heartBeatAckSubscriber) this.unsubscribe(this._heartBeatAckSubscriber)
        var heartBeatAcknowledged = true
        this._heartBeatAckSubscriber = this.subToOpcode([11], (msg) => {
            // console.log('Heartbeat acknowledged', new Date())
            heartBeatAcknowledged = true
        })
        if (this._heartBeatInterval) clearInterval(this._heartBeatInterval)
        this._heartBeatInterval = setInterval(() => {
            if (!heartBeatAcknowledged) {
                clearInterval(this._heartBeatInterval)
                this._ws.close()
                this.unsubscribe(this._heartBeatAckSubscriber)
                console.log('Last heartbeat was not acknowledged, breaking connection and reconnecting', new Date())
                setImmediate(() => {
                    this.init()
                })
                return
            }
            this.sendMessage(1)
                // console.log('Heartbeat sent', new Date())
            heartBeatAcknowledged = false
        }, hello.data.heartbeat_interval)

        if (!this.sessionId) {
            // If no session is to be continued
            var authConfirm = this.awaitOneEvent('READY')
            this.sendMessage(2, {
                token: this.token,
                intents: 513,
                properties: {
                    $os: 'linux',
                    $browser: 'DiscordClient',
                    $device: 'DiscordClient'
                }
            })
            authConfirm = await authConfirm
            console.log('Successfully set up a session', new Date())
            if (!this.isInit) this.signalInit()
            this.sessionId = authConfirm.data.session_id

        } else {
            // If a session ID is present

            // Await both a confirmation of the resume and an invalid session signal.
            // First one "wins" and the other promise is aborted
            var resumeConfirm = this.awaitOneEvent('RESUMED')
            var invalidSession = this.awaitOneOpCode(9)
            console.log(`Attempting to resume session ${this.sessionId} at sequence ${this.sequence}`)
            this.sendMessage(6, {
                token: this.token,
                session_id: this.sessionId,
                seq: this.sequence
            })
            resumeConfirm.then(res => {
                invalidSession.abort()
                console.log('Resumed a session')
                if (!this.isInit) this.signalInit()
            }).catch(err => {})
            invalidSession.then(res => {
                resumeConfirm.abort()
                console.log('Failed to resume session')
            }).catch(err => {})
        }
    }

    msgSubscriptions = {}

    // Yeah
    async sendMessage(opCode, data = {}) {
        this._ws.send(JSON.stringify({
            op: opCode,
            d: data
        }))
    }

    // Calls all subscribers who care about a message (by op code or event name)
    handleMsg(msg) {
        const content = JSON.parse(msg)
        if (content.op === 0) this.sequence = content.s
        var interestedSubscribers = Object.values(this.msgSubscriptions).filter(val => val.opCodes.includes(content.op) || val.events.includes(content.t))
        interestedSubscribers.forEach(val => val.callback({
            data: content.d || {},
            opCode: content.op,
            event: content.t
        }))
    }

    /**
     * Subscribes to all messages with opcodes in the opCodes array
     * @param {Array} opCodes Array of opcodes to subscribe to
     * @param {function} callback Callback
     * @returns Subscription ID required to unsubscribe
     */
    subToOpcode(opCodes, callback) {
        const subId = crypto.randomBytes(16).toString('hex')
        this.msgSubscriptions[subId] = {
            events: [],
            opCodes: opCodes,
            callback: callback
        }
        return subId
    }

    /**
     * Subscribes to all messages with event names in the events array
     * @param {Array} events Array of event names to subscribe to
     * @param {function} callback Callback
     * @returns Subscription ID required to unsubscribe
     */
    subToEvent(events, callback) {
        const subId = crypto.randomBytes(16).toString('hex')
        this.msgSubscriptions[subId] = {
            events: events,
            opCodes: [],
            callback: callback
        }
        return subId
    }

    /**
     * Returns a promise which resolves with the next message that matches the given opcode
     * @param {number} opCode 
     * @returns Promise 
     */
    awaitOneOpCode(opCode) {
        var subId
        var abortPromise
        var promise = new Promise((resolve, reject) => {
            abortPromise = reject
            subId = this.subToOpcode([opCode], (msg) => {
                resolve(msg)
                this.unsubscribe(subId)
            })
        })
        promise.abort = () => {
            this.unsubscribe(subId)
            abortPromise()
        }
        return promise
    }

    /**
     * Returns a promise which resolves with the next message that matches the given event name
     * @param {string} event
     * @returns Promise 
     */
    awaitOneEvent(event) {
        var subId
        var abortPromise
        var promise = new Promise((resolve, reject) => {
            abortPromise = reject
            subId = this.subToEvent([event], (msg) => {
                resolve(msg)
                this.unsubscribe(subId)
            })
        })
        promise.abort = () => {
            this.unsubscribe(subId)
            abortPromise()
        }
        return promise
    }

    /**
     * Removes a subscription with the given ID
     * @param {string} id 
     */
    unsubscribe(id) {
        delete this.msgSubscriptions[id]
    }

}

/**
 * A client to the Discord API. Let's you make requests to the API and subscribe to gateway events
 * @param {string} token Bot token
 * @param {string} resumeSession Session ID to attempt to resume
 */
const DiscordClient = class {
    constructor(token, resumeSession = null, resumeSequence = null) {
        this._beginSessionId = resumeSession
        this._beginSequence = resumeSequence
        this.token = token
        this.isInit = false
        this.init()
        this.awaitInit = new Promise(resolve => {
            this.signalInit = resolve
        }).then((res) => {
            this.isInit = true
        })
    }

    async init() {
        /** The managed connection to the Discord "gateway" */
        this.gatewaySocket = new GateWaySocket(this.token, this._beginSessionId, this._beginSequence)
        await this.gatewaySocket.awaitInit
        console.log(`Initialised gateway (${this.gatewaySocket.sessionId})`)
        this.signalInit()
    }

    /**
     * Makes a request to the given endpoint. Body content type is json by default.
     * @param {string} method HTTP request method
     * @param {string} endpoint The API endpoint, without the /api/v8 bit
     * @param {*} data Any valid http request body, or a plain object which will be JSON-stringified
     * @param {string} contentType Request body content type. Json by default.
     * @returns 
     */
    async request(method, endpoint, data = '', contentType = 'application/json') {
        await this.awaitInit

        if (typeof data === 'object')
            data = JSON.stringify(data)
        var options = {
            timeout: 5000,
            method: method,
            hostname: 'discordapp.com',
            path: `/api/v8${endpoint}`,
            headers: {
                authorization: `Bot ${this.token}`,
                'content-type': contentType,
            }
        }

        // console.log(options)
        var res = await httpReq(options, data)
        var data = res.data
        try {
            data = JSON.parse(data)
        } catch (err) {
            if (!data) {
                data = {}
            }
        }
        return {
            status: res.status,
            data: data
        }
    }

}

module.exports = DiscordClient