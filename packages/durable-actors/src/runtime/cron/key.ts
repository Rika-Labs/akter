/** Timer keys the runtime keeps for `policy.cron`; application intents may not use them. */
export const CRON_PREFIX = "$cron:"

/** Appears in a stored caller exactly when it is `System({ source: "cron" })`. */
export const CRON_CALLER = '"source":"cron"'
