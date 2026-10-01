const TOKEN = /^(0|[1-9]\d*)$/

/** Whether `value` is a commit version token: decimal digits without leading zeros, as `durable-version` is written. */
export const isVersion = (value: string) => TOKEN.test(value)
