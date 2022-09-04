export type HuobiSymbolsResponse = {
    status: "ok" | "error"
    data: Array<{
        "base-currency": string
        "quote-currency": string
        "price-precision": number // quote-currency dp
        "amount-precision": number // base-currency dp
        "symbol-partition": "main" | "innovation"
        "symbol": string
        "state": "online" | "offline" | "suspend" | "pre-online"
        "value-precision": number
        "min-order-amt": number
        "max-order-amt": number
        "min-order-value": number
        "limit-order-min-order-amt": number
        "limit-order-max-order-amt": number
        "limit-order-max-buy-amt": number
        "limit-order-max-sell-amt": number
        "buy-limit-must-less-than": number
        "sell-limit-must-greater-than": number
        "sell-market-min-order-amt": number
        "sell-market-max-order-amt": number
        "buy-market-max-order-value": number
        "market-sell-order-rate-must-less-than": number
        "market-buy-order-rate-must-less-than": number
        "api-trading": "enabled" | "disabled"
        "tags": string
    }>
}
export type HuobiWebSocketResponse = {
    id?: string
    status?: "ok"
    subbed?: string
    unsubbed?: string
    ts?: number
    ping?: number
    ch?: string
    tick?: {
        open :number
        high :number
        low :number
        close :number
        amount :number
        vol :number
        count :number
        bid :number
        bidSize :number
        ask :number
        askSize :number
        lastPrice :number
        lastSize :number
    }
}
export type HuobiTelegramNotificationsSymbols = {
    [baseCurrency: string]: {
        [quoteCurrency: string]: HuobiSymbolsResponse["data"][0]
    }
}
export type HuobiTelegramNotificationsTradingPairs = {
    [baseCurrency: string]: {
        symbol: string
        baseCurrency: string
        baseCurrencyDecimalPlaces: number
        quoteCurrency: string
        quoteCurrencyDecimalPlaces: number
        notificationBuyPrice :number
        notificationStrikeCount :number
        notificationStrikeTimeoutId :NodeJS.Timeout
        notificationStrikeUnitPrice :number
        apeInPercentage :number
        apeInTimeoutId :NodeJS.Timeout
    }
}