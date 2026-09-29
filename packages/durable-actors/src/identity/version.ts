/** Decimal digits without leading zeros, as `durable-version` tokens are written. */
const TOKEN = /^(0|[1-9]\d*)$/

/** Whether `value` is a well-formed commit version token. */
export const isVersion = (value: string) => TOKEN.test(value)
