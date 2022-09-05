import {tryCatchFinallyUtil} from "./utils/error"
import {logError} from "./utils/log"
import axios, {AxiosResponse} from "axios"
import {config} from "dotenv"
import {HuobiSymbolsResponse, HuobiWebSocketResponse, HuobiTelegramSymbols, HuobiTelegramTradingPairs} from "index"
import WebSocket from "ws"
import {ungzip} from "node-gzip"
import {buySignalStrikeNotification, sendApeInNotification, startServiceNotification,} from "./utils/telegram"
import {fixDecimalPlaces} from "./utils/number"

config()

// Global Variables
let HUOBI_TELEGRAM_SYMBOLS: HuobiTelegramSymbols = {}
let HUOBI_TELEGRAM_TRADING_PAIRS: HuobiTelegramTradingPairs = {}
let HUOBI_MAIN_WEBSOCKET: WebSocket
let HUOBI_PING_TIMEOUT_ID: NodeJS.Timeout
let HUOBI_GET_SYMBOLS_INTERVAL_ID: NodeJS.Timeout

const resetRun = () => {
    HUOBI_MAIN_WEBSOCKET = undefined
    HUOBI_TELEGRAM_SYMBOLS = {}
    HUOBI_TELEGRAM_TRADING_PAIRS = {}

    clearPingTimeoutId()

    clearInterval(HUOBI_GET_SYMBOLS_INTERVAL_ID)
    HUOBI_GET_SYMBOLS_INTERVAL_ID = undefined

    run()
}

const clearPingTimeoutId = () => {
    if (HUOBI_PING_TIMEOUT_ID) {
        clearTimeout(HUOBI_PING_TIMEOUT_ID)
        HUOBI_PING_TIMEOUT_ID = undefined
    }
}

const getSymbols = () => {
    tryCatchFinallyUtil(() => {
        axios.get(`${process.env.HUOBI_REST_API_URL}/v1/common/symbols`)
            .then((response: AxiosResponse<HuobiSymbolsResponse>) => {
                if (response.data.status === "error") {
                    getSymbols()
                } else {
                    // Initial at startup
                    if (Object.entries(HUOBI_TELEGRAM_SYMBOLS).length === 0) {
                        response.data.data.forEach((symbol) => {
                            if (HUOBI_TELEGRAM_SYMBOLS[symbol["base-currency"]]) {
                                HUOBI_TELEGRAM_SYMBOLS[symbol["base-currency"]] = {
                                    ...HUOBI_TELEGRAM_SYMBOLS[symbol["base-currency"]],
                                    [symbol["quote-currency"]]: symbol
                                }
                            } else {
                                HUOBI_TELEGRAM_SYMBOLS[symbol["base-currency"]] = {
                                    [symbol["quote-currency"]]: symbol
                                }
                            }
                        })
                        processTradingPairs()
                    }
                    // Subsequent (Post-startup)
                    else {
                        const newHuobiSymbols: HuobiTelegramSymbols = {}

                        for (let a = 0; a < response.data.data.length; a++) {
                            const tradePair = response.data.data[a]
                            const baseCurrency = tradePair["base-currency"]
                            if (!HUOBI_TELEGRAM_SYMBOLS[baseCurrency]) {
                                // New
                                if (newHuobiSymbols[baseCurrency]) {
                                    newHuobiSymbols[baseCurrency] = {
                                        ...newHuobiSymbols[baseCurrency],
                                        [tradePair["quote-currency"]]: tradePair
                                    }
                                } else {
                                    newHuobiSymbols[baseCurrency] = {
                                        [tradePair["quote-currency"]]: tradePair
                                    }
                                }
                            }
                        }

                        const deleteHuobiSymbols: HuobiTelegramSymbols = {}
                        const apiHuobiSymbols: HuobiTelegramSymbols = {}

                        for (let a = 0; a < response.data.data.length; a++) {
                            const tradePair = response.data.data[a]
                            const baseCurrency = tradePair["base-currency"]
                            if (apiHuobiSymbols[baseCurrency]) {
                                apiHuobiSymbols[baseCurrency] = {
                                    ...apiHuobiSymbols[baseCurrency],
                                    [tradePair["quote-currency"]]: tradePair
                                }
                            } else {
                                apiHuobiSymbols[baseCurrency] = {
                                    [tradePair["quote-currency"]]: tradePair
                                }
                            }
                        }
                        const rgTraderHuobiSymbolsEntries: [string, HuobiTelegramSymbols[""]][] = Object.entries(HUOBI_TELEGRAM_SYMBOLS)

                        for (let a = 0; a < rgTraderHuobiSymbolsEntries.length; a++) {
                            const [baseCurrency, tradePair] = rgTraderHuobiSymbolsEntries[a]
                            if (!apiHuobiSymbols[baseCurrency]) {
                                deleteHuobiSymbols[baseCurrency] = tradePair
                            } else {
                                if (HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency]) {
                                    if (!apiHuobiSymbols[baseCurrency][HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].quoteCurrency]) {
                                        deleteHuobiSymbols[baseCurrency] = tradePair
                                    } else {
                                        if (apiHuobiSymbols[baseCurrency][HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].quoteCurrency].state !== "online") {
                                            deleteHuobiSymbols[baseCurrency] = tradePair
                                        }
                                    }
                                }
                            }
                        }

                        HUOBI_TELEGRAM_SYMBOLS = {...apiHuobiSymbols}

                        processTradingPairs(newHuobiSymbols, deleteHuobiSymbols)
                    }
                }
            }).catch((e) => {
            logError(`getSymbols.axios() - ${e}`)
            getSymbols()
        })
    }, (e) => {
        logError(`getSymbols() - ${e}`)
        getSymbols()
    })
}

const processTradingPairs = (newSubscribeSymbols ?: HuobiTelegramSymbols, unsubscribeSymbols ?: HuobiTelegramSymbols) => {
    tryCatchFinallyUtil(() => {
        const markets: Array<string> = `${process.env.HUOBI_QUOTE_ASSETS}`.split(",").map((a) => a.toLowerCase())
        const rgHuobiSymbolsEntries: Array<[string, HuobiTelegramSymbols[""]]> = Object.entries(HUOBI_TELEGRAM_SYMBOLS)
        for (let a = 0; a < markets.length; a++) {
            for (let b = 0; b < rgHuobiSymbolsEntries.length; b++) {
                const [baseCurrency, value] = rgHuobiSymbolsEntries[b]
                if (!HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency]) {
                    if (HUOBI_TELEGRAM_SYMBOLS[baseCurrency][markets[a]]) {
                        const tradePair = value[markets[a]]
                        if (tradePair.state === "online") {
                            HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency] = {
                                symbol: tradePair.symbol,
                                baseCurrency: tradePair["base-currency"],
                                baseCurrencyDecimalPlaces: tradePair["amount-precision"],
                                quoteCurrency: tradePair["quote-currency"],
                                quoteCurrencyDecimalPlaces: tradePair["price-precision"],
                                notificationBuyPrice: 0,
                                notificationStrikeCount: 0,
                                notificationStrikeTimeoutId: undefined,
                                notificationStrikeUnitPrice: 0,
                                apeInPercentage: Number(process.env.APE_IN_START_PERCENTAGE),
                                apeInTimeoutId: undefined
                            }
                        }
                    }
                }
            }
        }

        // Initial at startup
        if (!newSubscribeSymbols && !unsubscribeSymbols) {
            runWebSocket()
        }
        // Subsequent
        else {
            const unsubscribeSymbolsEntries: [string, HuobiTelegramSymbols[""]][] = Object.entries(unsubscribeSymbols)
            if (unsubscribeSymbolsEntries.length > 0) {
                for (let a = 0; a < unsubscribeSymbolsEntries.length; a++) {
                    const [baseCurrency] = unsubscribeSymbolsEntries[a]
                    const tradePair: HuobiTelegramTradingPairs[""] = HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency]
                    HUOBI_MAIN_WEBSOCKET.send(JSON.stringify({
                        unsub: `market.${tradePair.symbol}.ticker`,
                        id: String(new Date().getTime()),
                    }))
                }
            }

            const newSubscribeSymbolsEntries: [string, HuobiTelegramSymbols[""]][] = Object.entries(newSubscribeSymbols)
            if (newSubscribeSymbolsEntries.length > 0) {
                for (let a = 0; a < newSubscribeSymbolsEntries.length; a++) {
                    const [baseCurrency] = newSubscribeSymbolsEntries[a]
                    const tradePair: HuobiTelegramTradingPairs[""] = HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency]
                    if (tradePair) {
                        HUOBI_MAIN_WEBSOCKET.send(JSON.stringify({
                            sub: `market.${tradePair.symbol}.ticker`,
                            id: String(new Date().getTime()),
                        }))
                    }
                }
            }
        }
    }, (e) => {
        logError(`processTradingPairs() - ${e}`)
        resetRun()
    })
}

const getBaseAssetName = (tradingPair: string) => {
    const regExp: RegExp = new RegExp(`^(\\w+)(` + process.env.HUOBI_QUOTE_ASSETS.replace(/,/g,"|") + `)$`)
    return tradingPair.toUpperCase().replace(regExp, '$1').toLowerCase()
}
const getSymbolFromTopic = (topic: string) => {
    return topic.replace(new RegExp('^(market\\.)(\\w+)(\\.ticker)'), "$2")
}
const processData = (Data: HuobiWebSocketResponse) => {
    let symbol: string = ''
    tryCatchFinallyUtil(
        () => {
            if (Data.ping) {
                clearPingTimeoutId()

                HUOBI_MAIN_WEBSOCKET.send(JSON.stringify({
                    pong: Data.ping
                }))

                HUOBI_PING_TIMEOUT_ID = setTimeout(() => {
                    HUOBI_MAIN_WEBSOCKET.terminate()
                }, Number(process.env.HUOBI_WEBSOCKET_PING_TIMEOUT_SECONDS) * 1000) as NodeJS.Timeout
            }
            if (Data.subbed) {
                symbol = getSymbolFromTopic(Data.subbed)
                if (Data.status !== "ok") {
                    // retry to subscribe
                    HUOBI_MAIN_WEBSOCKET.send(JSON.stringify({
                        sub: `market.${symbol}.ticker`,
                        id: String(new Date().getTime()),
                    }))
                }
            }
            if (Data.unsubbed) {
                symbol = getSymbolFromTopic(Data.unsubbed)
                if (Data.status !== "ok") {
                    // retry to unsubscribe
                    HUOBI_MAIN_WEBSOCKET.send(JSON.stringify({
                        unsub: `market.${symbol}.ticker`,
                        id: String(new Date().getTime()),
                    }))
                }
            }
            if (Data.tick) {
                symbol = getSymbolFromTopic(Data.ch)
                let tradingPair: HuobiTelegramTradingPairs[""] = HUOBI_TELEGRAM_TRADING_PAIRS[getBaseAssetName(symbol)]
                if (tradingPair) {
                    const {baseCurrency, quoteCurrency} = tradingPair
                    // Notifications service
                    const newNotificationBuyPrice: number = tradingPair.notificationStrikeCount === 0 ?
                        fixDecimalPlaces((1.00 + Number(process.env.HUOBI_NOTIFICATIONS_STRIKE_UNIT_PERCENT)) * Data.tick.lastPrice, tradingPair.quoteCurrencyDecimalPlaces) :
                        fixDecimalPlaces(tradingPair.notificationBuyPrice + tradingPair.notificationStrikeUnitPrice, tradingPair.quoteCurrencyDecimalPlaces)

                    if (tradingPair.notificationBuyPrice) {
                        if (newNotificationBuyPrice < tradingPair.notificationBuyPrice) {
                            HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationBuyPrice = newNotificationBuyPrice
                        }
                    } else {
                        HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationBuyPrice = newNotificationBuyPrice
                    }
                    if (Data.tick.lastPrice >= tradingPair.notificationBuyPrice && tradingPair.notificationBuyPrice !== 0) {
                        HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeCount += 1
                        tradingPair = HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency]
                        if (tradingPair.notificationStrikeCount === 1) {
                            HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeUnitPrice = fixDecimalPlaces((tradingPair.notificationBuyPrice * Number(process.env.HUOBI_NOTIFICATIONS_STRIKE_UNIT_PERCENT)) / (1.00 + Number(process.env.HUOBI_NOTIFICATIONS_STRIKE_UNIT_PERCENT)), tradingPair.quoteCurrencyDecimalPlaces)
                        }

                        tradingPair = HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency]
                        if (tradingPair.notificationStrikeCount > 1) buySignalStrikeNotification(symbol.toUpperCase(), Data.tick.lastPrice, tradingPair.notificationStrikeCount, Number(process.env.HUOBI_NOTIFICATIONS_STRIKE_UNIT_PERCENT), quoteCurrency.toUpperCase())

                        if (tradingPair.notificationStrikeTimeoutId) clearTimeout(tradingPair.notificationStrikeTimeoutId)
                        HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeTimeoutId = setTimeout(
                            () => {
                                HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeCount = 0
                                HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationBuyPrice = 0
                                HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeUnitPrice = 0

                                clearTimeout(HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeTimeoutId)
                                HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeTimeoutId = undefined
                            }, 1000 * 60 * Number(process.env.HUOBI_NOTIFICATIONS_STRIKE_TIMEOUT_MINS) * tradingPair.notificationStrikeCount
                        ) as NodeJS.Timeout
                        HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationBuyPrice = tradingPair.notificationBuyPrice + tradingPair.notificationStrikeUnitPrice
                    }

                    // APE-IN service
                    const percentChange: number = Math.round(((Data.tick.lastPrice - Data.tick.high) / Data.tick.high) * 10000) / 100
                    if ((percentChange < tradingPair.apeInPercentage)) {
                        // Send notification
                        sendApeInNotification(symbol.toUpperCase(), percentChange)

                        // Set next percentage
                        HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].apeInPercentage = tradingPair.apeInPercentage + Number(process.env.APE_IN_INCREMENT_PERCENTAGE)
                        if (tradingPair.apeInTimeoutId) {
                            clearTimeout(tradingPair.apeInTimeoutId)
                        }
                        HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].apeInTimeoutId = setTimeout(() => {
                            // Reset notification percentage
                            HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].apeInPercentage = Number(process.env.APE_IN_START_PERCENTAGE)

                            clearTimeout(HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].apeInTimeoutId)
                            HUOBI_TELEGRAM_TRADING_PAIRS[baseCurrency].apeInTimeoutId = undefined
                        }, 1000 * 60 * 60 * Number(process.env.APE_IN_PERCENT_TIMEOUT_HRS))
                    }
                }
            }
        }, (e) => {
            logError(`processData(${symbol}) error : ${e}`)
            processData(Data)
        })
}
const runWebSocket = () => {
    tryCatchFinallyUtil(
        () => {
            HUOBI_MAIN_WEBSOCKET = new WebSocket(process.env.HUOBI_WEBSOCKET_URL)

            HUOBI_MAIN_WEBSOCKET.on("open", () => {
                Object.entries(HUOBI_TELEGRAM_TRADING_PAIRS).forEach(([key, value]) => {
                    HUOBI_MAIN_WEBSOCKET.send(JSON.stringify({
                        sub: `market.${value.symbol}.ticker`,
                        id: String(new Date().getTime()),
                    }))
                })
            })

            HUOBI_MAIN_WEBSOCKET.on("message", (data: Buffer, isBinary) => {
                tryCatchFinallyUtil(
                    () => {
                        if (isBinary) {
                            ungzip(data).then((value: Buffer) => {
                                const Data: HuobiWebSocketResponse = JSON.parse(value.toString())
                                processData(Data)
                            }).catch((reason) => {
                                logError(`runWebSocket.onMessage.ungzip() - ${reason}`)
                            })
                        } else {
                            const Data: HuobiWebSocketResponse = JSON.parse(data.toString())
                            processData(Data)
                        }
                    },
                    (error) => {
                        HUOBI_MAIN_WEBSOCKET.terminate()
                        logError(`runWebSocket.onMessage() - ${error}`)
                    }
                )
            })

            HUOBI_MAIN_WEBSOCKET.on('close', ((code, reason) => {
                logError(`runWebSocket.onClose() - ${code} => ${reason}`)

                HUOBI_MAIN_WEBSOCKET = undefined
                clearPingTimeoutId()

                runWebSocket()
            }))

            HUOBI_MAIN_WEBSOCKET.on("error", (error) => {
                HUOBI_MAIN_WEBSOCKET.terminate()
                logError(`runWebSocket.onError() - ${error}`)
            })
        }, (e) => {
            logError(`runWebSocket() - ${e}`)
            if (HUOBI_MAIN_WEBSOCKET)
                HUOBI_MAIN_WEBSOCKET.terminate()
            else {
                HUOBI_MAIN_WEBSOCKET = undefined
                clearPingTimeoutId()

                runWebSocket()
            }
        })
}

const run = () => {
    startServiceNotification()

    getSymbols()

    HUOBI_GET_SYMBOLS_INTERVAL_ID = setInterval(() => {
        getSymbols()
    }, 1000 * 60 * Number(process.env.HUOBI_SYMBOL_UPDATE_INTERVAL_MINS)) // Every 10min update our symbols. In case of new listings.
}

run()