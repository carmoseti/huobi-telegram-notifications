export {}

declare global {
    namespace NodeJS {
        interface ProcessEnv {
            HUOBI_REST_API_URL: string
            HUOBI_QUOTE_ASSETS: string
            HUOBI_WEBSOCKET_URL: string
            HUOBI_WEBSOCKET_PING_TIMEOUT_SECONDS: string
            HUOBI_SYMBOL_UPDATE_INTERVAL_MINS: string
            HUOBI_NOTIFICATIONS_STRIKE_UNIT_PERCENT: string
            HUOBI_NOTIFICATIONS_STRIKE_TIMEOUT_MINS: string
            TELEGRAM_API_URL: string
            TELEGRAM_BOT_CHAT_ID: string
            TELEGRAM_BOT_TOKEN_SECRET: string
            TELEGRAM_APE_IN_BOT_TOKEN_SECRET: string
            APE_IN_START_PERCENTAGE: string
            APE_IN_INCREMENT_PERCENTAGE: string
            APE_IN_PERCENT_TIMEOUT_HRS: string
            EMAIL_HOST: string
            EMAIL_PORT: string
            EMAIL_PROTOCOL: string
            EMAIL_USER: string
            EMAIL_PASSWORD: string
            EMAIL_SENDER_NAME: string
            EMAIL_RECEIVER_NAME: string
            EMAIL_RECEIVER_ADDRESS: string
            EMAIL_RECEIVER_CC: string
            USER_NAME: string
        }
    }
}
