'use strict'

var net = require('net');

const packVarInt = (value) => {
    var result = []
    do {
        var temp = value & 0b01111111
        value >>>= 7
        if (value !== 0) {
            temp |= 0b10000000
        }
        result.push(temp)
    } while (value !== 0)
    return result
}

const popVarInt = (bytes) => {
    var numRead = 0
    var result = 0
    var read
    do {
        read = bytes.shift()
        var value = (read & 0b01111111)
        result |= (value << (7 * numRead))

        numRead++
        if (numRead > 5) {
            throw new Error('VarInt is too big')
        }
    } while ((read & 0b10000000) !== 0)
    return result
}

const getServerStatus = (host, port) => {
    return new Promise((resolve, reject) => {
        const intToBytes = (int, length) => {
            var bytes = [...new Uint8Array(Buffer.from(int.toString(16), 'hex'))]
            bytes = [
                ...(new Array(bytes.length - length)),
                ...bytes
            ]
            return bytes
        }

        const packData = (data) => {
            return [...packVarInt(data.length), ...data]
        }

        var client = new net.Socket()

        setTimeout(() => {
            client.close()
            reject(new Error('timeout'))
        }, 3000)

        client.on('error', (err) => {
            reject(err)
        })

        client.connect(port, host, (err) => {
            try {
                var data = [
                    ...packData([
                        0, 0,
                        ...packData(new Uint8Array(Buffer.from(host, 'utf8'))),
                        ...intToBytes(port, 2).reverse(),
                        1
                    ]),
                    1, 0
                ]
                client.write(new Uint8Array(data))
            } catch (err) {
                reject(err)
            }
        })

        var fullData = []
        var bytesRecvd = 0
        var dataLength
        var firstChunk = true
        client.on('data', (data) => {
            try {
                fullData.push(...data)
                bytesRecvd += data.length

                if (firstChunk) {
                    firstChunk = false

                    dataLength = popVarInt(fullData)
                    popVarInt(fullData)
                    popVarInt(fullData)
                }

                if (bytesRecvd >= dataLength) {
                    client.destroy()
                }
            } catch (err) {
                reject(err)
            }
        })

        client.on('close', function() {
            try {
                var parsedResult = JSON.parse(Buffer.from(fullData).toString('utf8'))
                resolve(parsedResult)
            } catch (err) {
                reject(err)
            }
        })
    })
}

module.exports = getServerStatus