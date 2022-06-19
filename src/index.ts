import axios from "axios";
import Websocket from "ws";
import WebSocket from "ws";
import {logError} from "./utils/log";
import {ungzip} from "node-gzip";
import {tryCatchFinallyUtil} from "./utils/error";
import {fixDecimalPlaces} from "./utils/number";
import {buySignalStrikeNotification, sendApeInNotification, startServiceNotification} from "./utils/telegram";
import {config} from "dotenv";

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

const APE_IN_SYMBOLS: {
    [symbol: string]: {
        percentage: number
        timeoutId: NodeJS.Timeout
    }
} = {}
const WEBSOCKET_SYMBOL_CONNECTIONS: { [symbol: string]: WebSocket } = {};
const runIndividualSymbolTickerStream = (symbol: string,
                                         previous ?: {
                                             notificationBuyPrice: number
                                             notificationStrikeCount: number
                                             notificationStrikeTimeoutId: NodeJS.Timeout
                                             notificationStrikeUnitPrice: number
                                             rateLimitTimeout: number
                                             errorRetryCount: number
                                         }) => {
    let errorRetryCount: number = previous ? previous.errorRetryCount : 0;
    if (errorRetryCount > Number(process.env.HUOBI_WEBSOCKET_ERROR_MAX_RETRY_COUNT)) {
        return false;
    }

    const ws: WebSocket = new WebSocket(process.env.HUOBI_WEBSOCKET_URL);
    WEBSOCKET_SYMBOL_CONNECTIONS[symbol] = ws;

    let notificationBuyPrice: number = previous ? previous.notificationBuyPrice : 0;
    let notificationStrikeCount: number = previous ? previous.notificationStrikeCount : 0;
    let notificationStrikeTimeoutId: NodeJS.Timeout = previous ? previous.notificationStrikeTimeoutId : undefined;
    let notificationStrikeUnitPrice: number = previous ? previous.notificationStrikeUnitPrice : 0;

    const quoteAsset: string = getQuoteAssetName(symbol.toUpperCase())

    const processData = (Data: Record<string, any>) => {
        if (Data.ping) {
            ws.send(JSON.stringify({
                pong: Data.ping
            }));
        }
        if (Data.tick) {
            // Notifications
            const newNotificationBuyPrice: number = notificationStrikeCount === 0 ?
                fixDecimalPlaces((1.00 + Number(process.env.HUOBI_NOTIFICATIONS_STRIKE_UNIT_PERCENT)) * Data.tick.lastPrice, 12) :
                fixDecimalPlaces(notificationBuyPrice + notificationStrikeUnitPrice, 12);

            if (notificationBuyPrice) {
                if (newNotificationBuyPrice < notificationBuyPrice) {
                    notificationBuyPrice = newNotificationBuyPrice;
                }
            } else {
                notificationBuyPrice = newNotificationBuyPrice;
            }
            if (Data.tick.lastPrice >= notificationBuyPrice && notificationBuyPrice !== 0) {
                notificationStrikeCount += 1;
                if (notificationStrikeCount === 1) {
                    notificationStrikeUnitPrice = fixDecimalPlaces((notificationBuyPrice * Number(process.env.HUOBI_NOTIFICATIONS_STRIKE_UNIT_PERCENT)) / (1.00 + Number(process.env.HUOBI_NOTIFICATIONS_STRIKE_UNIT_PERCENT)), 12);
                }

                if (notificationStrikeCount > 1) buySignalStrikeNotification(symbol.toUpperCase(), Number(Data.tick.lastPrice), notificationStrikeCount, Number(process.env.HUOBI_NOTIFICATIONS_STRIKE_UNIT_PERCENT), quoteAsset);

                if (notificationStrikeTimeoutId) clearTimeout(notificationStrikeTimeoutId);
                notificationStrikeTimeoutId = setTimeout(
                    () => {
                        notificationStrikeCount = 0;
                        notificationBuyPrice = 0;
                        notificationStrikeUnitPrice = 0;

                        clearTimeout(notificationStrikeTimeoutId);
                        notificationStrikeTimeoutId = undefined;
                    }, 1000 * 60 * Number(process.env.HUOBI_NOTIFICATIONS_STRIKE_TIMEOUT_MINS) * notificationStrikeCount
                ) as NodeJS.Timeout;
                notificationBuyPrice = notificationBuyPrice + notificationStrikeUnitPrice
            }
        }

        if (Data.tick) {
            // Ape in service
            if (APE_IN_SYMBOLS[symbol]) {
                const apeInParameters = APE_IN_SYMBOLS[symbol]
                const percentChange: number = Math.round(((Number(Data.tick.lastPrice) - Number(Data.tick.open)) / Number(Data.tick.open)) * 100) / 100
                if (percentChange < apeInParameters.percentage) {
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
    }

    tryCatchFinallyUtil(
        () => {
            ws.on("open", () => {
                errorRetryCount = 0;
                ws.send(JSON.stringify({
                    sub: `market.${symbol}.ticker`,
                    id: String(new Date().getTime()),
                }));
            });

            ws.on("message", (data: Buffer, isBinary) => {
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
                        ws.terminate();
                        logError(`webSocket onMessage error (): ${error}`)
                    }
                );
            });

            ws.on('close', ((code, reason) => {
                if (WEBSOCKET_SYMBOL_CONNECTIONS[symbol]) {
                    delete WEBSOCKET_SYMBOL_CONNECTIONS[symbol];

                    if (code === 1006) { // ws.terminate()
                        setTimeout(() => {
                            runIndividualSymbolTickerStream(symbol, {
                                errorRetryCount,
                                notificationBuyPrice,
                                notificationStrikeCount,
                                notificationStrikeTimeoutId,
                                notificationStrikeUnitPrice,
                                rateLimitTimeout: previous.rateLimitTimeout
                            });
                        }, previous.rateLimitTimeout);
                    }
                    if (code === 1005) { // ws.close()
                        setTimeout(() => {
                            runIndividualSymbolTickerStream(symbol, {
                                errorRetryCount,
                                rateLimitTimeout: previous.rateLimitTimeout,
                                notificationStrikeTimeoutId: undefined,
                                notificationStrikeUnitPrice: 0,
                                notificationStrikeCount: 0,
                                notificationBuyPrice: 0
                            });
                        }, previous.rateLimitTimeout);
                    }
                }
            }));

            ws.on("error", (error) => {
                errorRetryCount++;
                ws.terminate();
                logError(`webSocket error - ${symbol.toUpperCase()} (): ${error}`)
            });
        },
        (e) => {
            errorRetryCount++;
            ws.terminate();
            logError(`runIndividualSymbolTickerStream() error : ${e}`);
        }
    );
}

const SYMBOLS: { [symbol: string]: string } = {};
const initializeSymbols = () => {
    axios.get(`${process.env.HUOBI_REST_API_URL}/v1/common/symbols`)
        .then((response) => {
            if (response.data.status === "ok") {
                const symbols = response.data.data;
                // tslint:disable-next-line:prefer-for-of
                for (let a = 0; a < symbols.length; a++) {
                    const symbol = symbols[a];
                    if (hasSupportedQuoteAsset(String(symbol['quote-currency']).toUpperCase())) {
                        if (symbol.state === "online") {
                            SYMBOLS[symbol.symbol] = symbol.symbol;
                        } else {
                            if (WEBSOCKET_SYMBOL_CONNECTIONS[symbol.symbol]) {
                                delete SYMBOLS[symbol.symbol];

                                let ws = WEBSOCKET_SYMBOL_CONNECTIONS[symbol.symbol];
                                delete WEBSOCKET_SYMBOL_CONNECTIONS[symbol.symbol];
                                ws.close();
                                ws = undefined;
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

                let symbolKeys: string[] = Object.keys(SYMBOLS);
                // tslint:disable-next-line:prefer-for-of
                for (let a = 0; a < symbolKeys.length; a++) {
                    const baseAssetName: string = getBaseAssetName(symbolKeys[a].toUpperCase());
                    for (let i = 0; i < SUPPORTED_QUOTE_ASSETS.length; i++) {
                        const tradingPair: string = `${baseAssetName}${SUPPORTED_QUOTE_ASSETS[i]}`.toLowerCase()
                        if (SYMBOLS.hasOwnProperty(tradingPair)) {
                            const discardQuoteAssets: string[] = SUPPORTED_QUOTE_ASSETS.slice(i + 1)
                            discardQuoteAssets.forEach((value) => {
                                const removeSymbol: string = `${baseAssetName}${value}`.toLowerCase();
                                delete SYMBOLS[removeSymbol];

                                if (WEBSOCKET_SYMBOL_CONNECTIONS[removeSymbol]) {
                                    let websocket: Websocket = WEBSOCKET_SYMBOL_CONNECTIONS[removeSymbol];
                                    delete WEBSOCKET_SYMBOL_CONNECTIONS[removeSymbol];
                                    websocket.close();
                                    websocket = undefined;
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

                Object.keys(SYMBOLS).forEach((symbol, a) => {
                    const rateLimitTimeout: number = Number(process.env.HUOBI_WEBSOCKET_RATE_LIMIT_BASE_MS) * a;
                    if (!WEBSOCKET_SYMBOL_CONNECTIONS[symbol]) {
                        setTimeout(() => {
                            runIndividualSymbolTickerStream(symbol, {
                                errorRetryCount: 0,
                                notificationBuyPrice: 0,
                                notificationStrikeCount: 0,
                                notificationStrikeUnitPrice: 0,
                                notificationStrikeTimeoutId: undefined,
                                rateLimitTimeout
                            });
                        }, rateLimitTimeout);
                        APE_IN_SYMBOLS[symbol] = {
                            percentage: Number(process.env.APE_IN_START_PERCENTAGE),
                            timeoutId: undefined
                        }
                    }
                });

            }
        }, (reason) => {
            logError(`initializeSymbols() error: ${reason}`);
        })
        .catch((reason) => {
            logError(`initializeSymbols() error: ${reason}`)
        });
}

// Program
startServiceNotification();

initializeSymbols();
setInterval(() => {
    initializeSymbols();
}, 1000 * 60 * Number(process.env.HUOBI_SYMBOL_UPDATE_INTERVAL_MINS)); // Check symbols status every 10 mins

setInterval(() => {
    Object.keys(WEBSOCKET_SYMBOL_CONNECTIONS).forEach((symbol) => {
        WEBSOCKET_SYMBOL_CONNECTIONS[symbol].terminate();
    });
}, 1000 * 60 * 60 * Number(process.env.HUOBI_WEBSOCKET_FORCE_TERMINATE_HRS)); // Every 6hrs force terminate all websocket connections