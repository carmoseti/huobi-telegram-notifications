import axios from "axios";
import Websocket from "ws";
import WebSocket from "ws";
import {logError} from "./utils/log";
import {ungzip} from "node-gzip";
import {tryCatchFinallyUtil} from "./utils/error";
import {fixDecimalPlaces} from "./utils/number";
import {buySignalStrikeNotification, startServiceNotification} from "./utils/telegram";
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

    const processData = (Data: any) => {
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
                                // {
                                //     "ch":"market.ftmusdt.ticker",
                                //     "ts":1637636692805,
                                //     "tick":{
                                //         "open":2.0022,
                                //         "high":2.072,
                                //         "low":1.9264,
                                //         "close":1.9941,
                                //         "amount":135779.76309029965,
                                //         "vol":271819.2759354684,
                                //         "count":5230,
                                //         "bid":1.9898,
                                //         "bidSize":34.9654,
                                //         "ask":1.9987,
                                //         "askSize":502.0,
                                //         "lastPrice":1.9941,
                                //         "lastSize":4.9225
                                //     }
                                // }
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
                    // {
                    //     "base-currency": "trx",
                    //     "quote-currency": "usdt",
                    //     "price-precision": 6,
                    //     "amount-precision": 2,
                    //     "symbol-partition": "main",
                    //     "symbol": "trxusdt",
                    //     "state": "online",
                    //     "value-precision": 8,
                    //     "min-order-amt": 1,
                    //     "max-order-amt": 38000000,
                    //     "min-order-value": 5,
                    //     "limit-order-min-order-amt": 1,
                    //     "limit-order-max-order-amt": 38000000,
                    //     "limit-order-max-buy-amt": 38000000,
                    //     "limit-order-max-sell-amt": 38000000,
                    //     "sell-market-min-order-amt": 1,
                    //     "sell-market-max-order-amt": 3800000,
                    //     "buy-market-max-order-value": 100000,
                    //     "leverage-ratio": 5,
                    //     "super-margin-leverage-ratio": 3,
                    //     "api-trading": "enabled",
                    //     "tags": "activities"
                    // }
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