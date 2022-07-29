import axios from "axios";
import {logError} from "./utils/log";
import {config} from "dotenv";
import {buySignalStrikeNotification, sendApeInNotification, startServiceNotification} from "./utils/telegram";
import WebSocket from "ws";
import {tryCatchFinallyUtil} from "./utils/error";
import {ungzip} from "node-gzip";
import {fixDecimalPlaces} from "./utils/number";

// Load .env properties
config();

const SUPPORTED_QUOTE_ASSETS: string[] = String(process.env.HUOBI_QUOTE_ASSETS).split(",");
const getBaseAssetName = (tradingPair: string) => {
    let baseAssetName: string = tradingPair;

    // tslint:disable-next-line:prefer-for-of
    for (let i = 0; i < SUPPORTED_QUOTE_ASSETS.length; i++) {
        if (tradingPair.startsWith(SUPPORTED_QUOTE_ASSETS[i])) {
            return SUPPORTED_QUOTE_ASSETS[i];
        }
    }

    SUPPORTED_QUOTE_ASSETS.forEach((quoteAsset: string) => {
        baseAssetName = baseAssetName.replace(quoteAsset, '')
    });
    return baseAssetName;
}
const getQuoteAssetName = (tradingPair: string) => {
    return tradingPair.replace(getBaseAssetName(tradingPair), '')
}
const hasSupportedQuoteAsset = (tradingPair: string): boolean => {
    return SUPPORTED_QUOTE_ASSETS.reduce((previousValue, currentValue) => {
        return previousValue || (tradingPair.search(currentValue) !== -1 && tradingPair.endsWith(currentValue))
    }, false)
}

const getSymbolFromTopic = (topic :string) => {
    return topic.replace("market.","").replace(".ticker","")
}

let MAIN_WEBSOCKET: WebSocket
const processData = (Data: Record<string, any>) => {
    if (Data.ping) {
        MAIN_WEBSOCKET.send(JSON.stringify({
            pong: Data.ping
        }));
    }
    if (Data.tick) {
        const symbol: string = getSymbolFromTopic(Data.ch as string)
        const quoteAsset: string = getQuoteAssetName(symbol.toUpperCase())
        // Notifications
        const newNotificationBuyPrice: number = SYMBOLS[symbol].notificationStrikeCount === 0 ?
            fixDecimalPlaces((1.00 + Number(process.env.HUOBI_NOTIFICATIONS_STRIKE_UNIT_PERCENT)) * Data.tick.lastPrice, 12) :
            fixDecimalPlaces(SYMBOLS[symbol].notificationBuyPrice + SYMBOLS[symbol].notificationStrikeUnitPrice, 12);

        if (SYMBOLS[symbol].notificationBuyPrice) {
            if (newNotificationBuyPrice < SYMBOLS[symbol].notificationBuyPrice) {
                SYMBOLS[symbol].notificationBuyPrice = newNotificationBuyPrice;
            }
        } else {
            SYMBOLS[symbol].notificationBuyPrice = newNotificationBuyPrice;
        }
        if (Data.tick.lastPrice >= SYMBOLS[symbol].notificationBuyPrice && SYMBOLS[symbol].notificationBuyPrice !== 0) {
            SYMBOLS[symbol].notificationStrikeCount += 1;
            if (SYMBOLS[symbol].notificationStrikeCount === 1) {
                SYMBOLS[symbol].notificationStrikeUnitPrice = fixDecimalPlaces((SYMBOLS[symbol].notificationBuyPrice * Number(process.env.HUOBI_NOTIFICATIONS_STRIKE_UNIT_PERCENT)) / (1.00 + Number(process.env.HUOBI_NOTIFICATIONS_STRIKE_UNIT_PERCENT)), 12);
            }

            if (SYMBOLS[symbol].notificationStrikeCount > 1) buySignalStrikeNotification(symbol.toUpperCase(), Number(Data.tick.lastPrice), SYMBOLS[symbol].notificationStrikeCount, Number(process.env.HUOBI_NOTIFICATIONS_STRIKE_UNIT_PERCENT), quoteAsset);

            if (SYMBOLS[symbol].notificationStrikeTimeoutId) clearTimeout(SYMBOLS[symbol].notificationStrikeTimeoutId);
            SYMBOLS[symbol].notificationStrikeTimeoutId = setTimeout(
                () => {
                    SYMBOLS[symbol].notificationStrikeCount = 0;
                    SYMBOLS[symbol].notificationBuyPrice = 0;
                    SYMBOLS[symbol].notificationStrikeUnitPrice = 0;

                    clearTimeout(SYMBOLS[symbol].notificationStrikeTimeoutId);
                    SYMBOLS[symbol].notificationStrikeTimeoutId = undefined;
                }, 1000 * 60 * Number(process.env.HUOBI_NOTIFICATIONS_STRIKE_TIMEOUT_MINS) * SYMBOLS[symbol].notificationStrikeCount
            ) as NodeJS.Timeout;
            SYMBOLS[symbol].notificationBuyPrice = SYMBOLS[symbol].notificationBuyPrice + SYMBOLS[symbol].notificationStrikeUnitPrice
        }
    }
    if (Data.tick) {
        const symbol: string = getSymbolFromTopic(Data.ch as string)
        // Ape in service
        if (APE_IN_SYMBOLS[symbol]) {
            const apeInParameters = APE_IN_SYMBOLS[symbol]
            const percentChange: number = Math.round(((Number(Data.tick.lastPrice) - Number(Data.tick.high)) / Number(Data.tick.high)) * 10000) / 100
            if ((percentChange < apeInParameters.percentage) &&
                // Avoid false -100% notifications from new-listings
                percentChange !== 100) {
                // Send notification
                sendApeInNotification(symbol.toUpperCase(), percentChange)

                // Set next percentage
                apeInParameters.percentage = apeInParameters.percentage + Number(process.env.APE_IN_INCREMENT_PERCENTAGE)
                if (apeInParameters.timeoutId) {
                    clearTimeout(apeInParameters.timeoutId)
                }
                apeInParameters.timeoutId = setTimeout(() => {
                    // Reset notification percentage
                    apeInParameters.percentage = Number(process.env.APE_IN_START_PERCENTAGE)

                    clearTimeout(apeInParameters.timeoutId)
                    apeInParameters.timeoutId = undefined
                }, 1000 * 60 * 60 * Number(process.env.APE_IN_PERCENT_TIMEOUT_HRS))
            }
        }
    }
    if (Data.subbed) {
        const symbol: string = getSymbolFromTopic(Data.subbed as string)
        if (Data.status === "ok") {
            console.log(JSON.stringify(Data))
            SYMBOLS[symbol].isWebSocketSubscribed = true
        } else {
            // Retry
        }
    }
}
const runWebSocket = () => {
    MAIN_WEBSOCKET = new WebSocket(process.env.HUOBI_WEBSOCKET_URL)

    tryCatchFinallyUtil(
        () => {
            MAIN_WEBSOCKET.on("open", () => {
                Object.entries(SYMBOLS).forEach(([key, symbol]) => {
                    if (!symbol.isWebSocketSubscribed) {
                        MAIN_WEBSOCKET.send(JSON.stringify({
                            sub: `market.${key}.ticker`,
                            id: String(new Date().getTime()),
                        }))
                        APE_IN_SYMBOLS[key] = {
                            percentage: Number(process.env.APE_IN_START_PERCENTAGE),
                            timeoutId: undefined
                        }
                    }
                })
            })

            MAIN_WEBSOCKET.on("message", (data: Buffer, isBinary) => {
                tryCatchFinallyUtil(
                    () => {
                        if (isBinary) {
                            ungzip(data).then((value: Buffer) => {
                                const Data = JSON.parse(value.toString());
                                processData(Data);
                            }).catch((reason) => {
                                logError(`websocket ungzip error () : ${reason}`)
                            });
                        } else {
                            const Data = JSON.parse(data.toString());
                            processData(Data);
                        }
                    },
                    (error) => {
                        MAIN_WEBSOCKET.terminate();
                        logError(`webSocket onMessage error (): ${error}`)
                    }
                );
            });

            MAIN_WEBSOCKET.on('close', ((code, reason) => {
                MAIN_WEBSOCKET = undefined
                logError(`runWebSocket() close : ${code} => ${reason}`)
                runWebSocket()
            }));

            MAIN_WEBSOCKET.on("error", (error) => {
                MAIN_WEBSOCKET.terminate();
                logError(`runWebSocket() error : ${error}`)
            });
        }, (e) => {
            MAIN_WEBSOCKET.terminate();
            logError(`runWebSocket() error : ${e}`);
        })
}

const APE_IN_SYMBOLS: {
    [symbol: string]: {
        percentage: number
        timeoutId: NodeJS.Timeout
    }
} = {}
const SYMBOLS: {
    [symbol: string]: {
        isWebSocketSubscribed: boolean
        notificationBuyPrice: number
        notificationStrikeCount: number
        notificationStrikeTimeoutId: NodeJS.Timeout
        notificationStrikeUnitPrice: number
    }
} = {};
const initializeSymbols = () => {
    axios.get(`${process.env.HUOBI_REST_API_URL}/v1/common/symbols`)
        .then((response) => {
            const symbols = response.data.data;
            // tslint:disable-next-line:prefer-for-of
            for (let a = 0; a < symbols.length; a++) {
                const symbol = symbols[a];
                if (hasSupportedQuoteAsset(String(symbol['quote-currency']).toUpperCase())) {
                    if (symbol.state === "online") {
                        if (!SYMBOLS[symbol.symbol]) {
                            SYMBOLS[symbol.symbol] = {
                                isWebSocketSubscribed: false,
                                notificationBuyPrice: 0,
                                notificationStrikeCount: 0,
                                notificationStrikeTimeoutId: undefined,
                                notificationStrikeUnitPrice: 0,
                            }
                        }
                    } else {
                        if (SYMBOLS[symbol.symbol]) {
                            if (SYMBOLS[symbol.symbol].isWebSocketSubscribed) {
                                MAIN_WEBSOCKET.send(JSON.stringify({
                                    unsub: `market.${symbol.symbol}.ticker`,
                                    id: String(new Date().getTime()),
                                }))
                            }
                            if (SYMBOLS[symbol.symbol].notificationStrikeTimeoutId) {
                                clearTimeout(SYMBOLS[symbol.symbol].notificationStrikeTimeoutId)
                            }
                            delete SYMBOLS[symbol.symbol]
                        }

                        if (APE_IN_SYMBOLS[symbol.symbol]) {
                            if (APE_IN_SYMBOLS[symbol.symbol].timeoutId) {
                                clearTimeout(APE_IN_SYMBOLS[symbol.symbol].timeoutId)
                            }
                            delete APE_IN_SYMBOLS[symbol.symbol]
                        }
                    }
                }
            }

            let symbolKeys: string[] = Object.keys(SYMBOLS)

            // tslint:disable-next-line:prefer-for-of
            for (let a = 0; a < symbolKeys.length; a++) {
                const baseAssetName: string = getBaseAssetName(symbolKeys[a].toUpperCase());
                for (let i = 0; i < SUPPORTED_QUOTE_ASSETS.length; i++) {
                    const tradingPair: string = `${baseAssetName}${SUPPORTED_QUOTE_ASSETS[i]}`.toLowerCase()
                    if (SYMBOLS.hasOwnProperty(tradingPair)) {
                        const discardQuoteAssets: string[] = SUPPORTED_QUOTE_ASSETS.slice(i + 1)
                        discardQuoteAssets.forEach((value) => {
                            const removeSymbol: string = `${baseAssetName}${value}`.toLowerCase()
                            if (SYMBOLS[removeSymbol]) {
                                if (SYMBOLS[removeSymbol].isWebSocketSubscribed) {
                                    MAIN_WEBSOCKET.send(JSON.stringify({
                                        unsub: `market.${removeSymbol}.ticker`,
                                        id: String(new Date().getTime()),
                                    }))
                                }
                                if (SYMBOLS[removeSymbol].notificationStrikeTimeoutId) {
                                    clearTimeout(SYMBOLS[removeSymbol].notificationStrikeTimeoutId)
                                }
                                delete SYMBOLS[removeSymbol]
                            }

                            if (APE_IN_SYMBOLS[removeSymbol]) {
                                if (APE_IN_SYMBOLS[removeSymbol].timeoutId) {
                                    clearTimeout(APE_IN_SYMBOLS[removeSymbol].timeoutId)
                                }
                                delete APE_IN_SYMBOLS[removeSymbol]
                            }
                        })
                    }
                }
                symbolKeys = Object.keys(SYMBOLS);
            }

            if (!MAIN_WEBSOCKET) {
                runWebSocket()
            } else {
                Object.entries(SYMBOLS).forEach(([key, symbol]) => {
                    if (!symbol.isWebSocketSubscribed) {
                        MAIN_WEBSOCKET.send(JSON.stringify({
                            sub: `market.${key}.ticker`,
                            id: String(new Date().getTime()),
                        }))

                        APE_IN_SYMBOLS[key] = {
                            percentage: Number(process.env.APE_IN_START_PERCENTAGE),
                            timeoutId: undefined
                        }
                    }
                })
            }
        }, (reason) => {
            logError(`initializeSymbols() error: ${reason}`)
        }).catch((reason) => {
        logError(`initializeSymbols() error: ${reason}`)
    })
}

// Program
startServiceNotification();

initializeSymbols()
setInterval(() => {
    initializeSymbols();
}, 1000 * 60 * Number(process.env.HUOBI_SYMBOL_UPDATE_INTERVAL_MINS)); // Check symbols status every x=10 mins