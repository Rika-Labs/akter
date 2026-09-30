/** A cursor is an event sequence: a non-negative 64-bit integer in canonical decimal. */
const CURSOR = /^(0|[1-9][0-9]{0,18})$/

const MAX_SEQUENCE = 2n ** 63n - 1n

/** True for a canonical cursor a stream could have issued. */
export const isCursor = (cursor: string) => CURSOR.test(cursor) && BigInt(cursor) <= MAX_SEQUENCE
