const basePath = __dirname;
const http = require('http')
const { readFileSync, writeFileSync, existsSync, appendFileSync, copyFileSync, createReadStream, readFile } = require("fs")
const { join: joinPath } = require('path')
const syncFrequency = 1000

var dataCopy
var dataLocation
var logsLocation
var syncDataTick
var cleanLogsTick
var lastSync
var server

const doPut = (key, value, data) => {
    if (key.length == 0) return

    const keyPath = key.toString().split(".")
    let dataCursor = data
    while(keyPath.length > 0) {
        const keySegment = keyPath.shift()
        if (keyPath.length == 0) {
            dataCursor[keySegment] = value
        } else { 
            if (!dataCursor[keySegment]) dataCursor[keySegment] =  {}  
            if (Object.prototype.toString.call(dataCursor[keySegment]) != '[object Object]') dataCursor[keySegment] =  {}
            dataCursor = dataCursor[keySegment]
        }
    }
}

const doGet = (key, data) => {
    const keyPath = key.split(".")
    let dataCursor = data

    while(keyPath.length > 0) {
        const keySegment = keyPath.shift()
        if (keyPath.length == 0) {
            return keySegment.length == 0 ? dataCursor : dataCursor[keySegment]
        } else { 
            if (!dataCursor[keySegment]) return undefined   
            dataCursor = dataCursor[keySegment]
        }
    }
}

const doDestroy = (key, data) => {
    const keyPath = key.split(".")
    let dataCursor = data
    while(keyPath.length > 0) {
        const keySegment = keyPath.shift()
        if (keyPath.length == 0) {
            dataCursor[keySegment] = undefined
        } else { 
            if (dataCursor[keySegment]) dataCursor = dataCursor[keySegment]
        }
    }
}

const get = (key) => {
    return doGet(key, dataCopy)
}

const put = (key, value) => {
    doPut(key, value, dataCopy)
    appendFileSync(logsLocation, `${Date.now()}:${key}:put\n`)
    syncData(key)
}

const destroy = (key) => {
    doDestroy(key, dataCopy)
    appendFileSync(logsLocation, `${Date.now()}:${key}:destroy\n`)
    syncData(key)
}

const backup = () => {    
    // generate a timestamped copy of data
    if (existsSync(dataLocation)) copyFileSync(dataLocation, `${dataLocation}.${Date.now()}`)
}

const syncData = (updatedKey) => {    
    // sync local data copy with shared data
    const startSync = Date.now()
    
    if (existsSync(dataLocation)) {
        const lastDataRawCopy = readFileSync(dataLocation)
        const lastDataCopy = JSON.parse(lastDataRawCopy)

        if (existsSync(logsLocation)) {
            const logRawCopy = readFileSync(logsLocation)
            logs = logRawCopy.toString().split('\n')
            // loop over logs to detect most recent versions of data records
            for (const log of logs) {
                const [ logTimestamp, logKey, logOp ] = log.split(':')
                if ( logTimestamp > lastSync && logKey != updatedKey) {
                    switch(logOp) {
                        case 'put':
                            const lastValue = doGet(logKey, lastDataCopy)
                            doPut(logKey, lastValue, dataCopy)
                        break;
                        case 'destroy':
                            doDestroy(logKey, dataCopy)
                        break;
                    }
                }
            }
        }
    }

    lastSync = startSync
    
    // persist only if a key was updated locally
    if (updatedKey) writeFileSync(dataLocation, JSON.stringify(dataCopy))
}

const cleanLogs = () => {
    const now = Date.now()

    // clean logs older than 2 * syncFrequency ( so that everyone syncing with db at syncFrequency should already be synchronized with those logs )    
    if (existsSync(logsLocation)) {
        const logRawCopy = readFileSync(logsLocation)
        const logs = logRawCopy.toString().split('\n')
        const cleanedLogs = []

        // loop over logs to detect most recent versions of data records
        for (const log of logs) {
            const [ timestamp ] = log.split(':')
            if ( timestamp > now - 2 * syncFrequency ) {
                cleanedLogs.push(log)
            }
        }

        writeFileSync(logsLocation, cleanedLogs.join('\n'))
    }
}

const startDatabaseEngine = (path) => {
    dataLocation = path 
    logsLocation = path + ".pocdb" 

    if (existsSync(dataLocation)) {
        const dataRawCopy = readFileSync(dataLocation)
        dataCopy = JSON.parse(dataRawCopy)
        lastSync = Date.now()
    } else {
        dataCopy = {}
    }

    syncDataTick = setInterval(() => {
        syncData()
    }, syncFrequency)

    cleanLogsTick = setInterval(() => {
        cleanLogs()
    }, syncFrequency)

    console.log(`pocdb database engine running for database ${path}`)

    process.on('SIGINT', () => {
        console.log(`pocdb : persisting db at ${dataLocation} ...`)
        stop()
    })

    process.on('SIGTERM', () => {
        console.log(`pocdb : persisting db at ${dataLocation} ...`)
        stop()
    })
}

const startHttpServer = (address, port) => {
    server = http.createServer((req, res) => {
        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Request-Method', '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, DELETE, PUT, POST');
        res.setHeader('Access-Control-Allow-Headers', '*');
        if ( req.method === 'OPTIONS' ) {
            res.writeHead(200);
            res.end();
            return;
        }

        // process request
        const { method, url } = req
        const path = url.split("/").filter(term => term.length > 0)

        if(path.length == 0) {
            return res.end("pocdb server listening...")
        }

        switch(path[0]) {
            default:
                return res.end("pocdb server listening...")
            case "_database":
                // Set content type header
                res.setHeader('Content-Type', 'application/json')

                const key = path.slice(1).join(".")
                switch(method) {
                    case 'GET':
                        const value = get(key)
                        if(!value) {
                            res.statusCode = 404
                            return res.end(JSON.stringify({
                                statusCode: 404,
                                message: "key not found"
                            }))
                        } else {
                            res.statusCode = 200
                            return res.end(JSON.stringify({
                                statusCode: 200,
                                value: value
                            }))
                        }
                    case 'POST':
                    case 'PUT':
                        let body = ''
                        req.on('data', chunk => {
                          body += chunk
                        })
                        req.on('end', () => {
                            const { value } = JSON.parse(body)
                            put(key, value)
                            res.end(JSON.stringify({
                                statusCode: 200,
                                message: "key updated"
                            }))
                        })
                    break
                    case 'DELETE':
                        destroy(key)
                        res.statusCode = 200
                        return res.end(JSON.stringify({
                            statusCode: 200,
                            message: "key destroyed"
                        }))
                }
            break
            case "_explorer":
                let filePath = joinPath(__dirname, req.url.replace("_explorer", "interface"))
                if (filePath == joinPath(__dirname, "interface")) filePath += "/index.html"

                try {
                    const content = readFileSync(filePath)
                    res.writeHead(200);
                    res.end(content);
                } catch(err) {
                    res.writeHead(404);
                    res.end(JSON.stringify(err));
                    return;
                }
            break
        }
    })

    server.on('clientError', (err, socket) => {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    });

    server.listen(port, () => {
        console.log(`pocdb http server listening at ${address}:${port}`)
    });
}

const start = ({ path, address = '127.0.0.1', port = 2222 }) => {
    if (!path) throw "missing path to data file in config"

    startDatabaseEngine(path)
    startHttpServer(address, port)

    process.on('SIGINT', () => {
        console.log(`pocdb : persisting db at ${dataLocation} ...`)
        stop()
    })

    process.on('SIGTERM', () => {
        console.log(`pocdb : persisting db at ${dataLocation} ...`)
        stop()
    })
}

const stop = () => {
    if(syncDataTick) clearInterval(syncDataTick)
    if(cleanLogsTick) clearInterval(cleanLogsTick)
    server.close()
    process.exit()
}

module.exports = { start, stop, get, put, destroy, backup }