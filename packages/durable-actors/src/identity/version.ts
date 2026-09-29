/** Decimal digits without leading zeros, as `durable-version` tokens are written. */
const TOKEN = /^(0|[1-9]\d*)$/

/** Whether `value` is a well-formed commit version token. */
export const isVersion = (value: string) => TOKEN.test(value)

/** The greater of two commit version tokens; either may be absent. */
export const maxVersion = (a: string | undefined, b: string | undefined) => {
  if (a === undefined) return b

  if (b === undefined) return a

  return BigInt(a) >= BigInt(b) ? a : b
}
