import { Option } from "effect"
import { dual } from "effect/Function"

const LAST_OFFSET = 0xffff_ffff_ffff_ffffn

const HEX16 = /^[0-9a-f]{16}$/u

const LEASE_KEY = /^(?:cluster|gc)\/[A-Za-z0-9._%-]+(?:\/[A-Za-z0-9._%-]+)*$/u

const LEASE_PREFIX = /^(?:cluster|gc)\/(?:[A-Za-z0-9._%-]+\/)*$/u

const hex16 = (value: bigint) => value.toString(16).padStart(16, "0")

const parseHex16 = (text: string): Option.Option<bigint> =>
  HEX16.test(text) ? Option.some(BigInt(`0x${text}`)) : Option.none()

/** The store's identity record, written once when the store is created. */
export const META_KEY = "meta/store"

/** The effective retention and its audit, replaced only by compare-and-swap. */
export const RETENTION_KEY = "meta/retention"

/** Prefix of every content-addressed page. */
export const PAGES_PREFIX = "pages/"

/** Objects under one shard, `s/<shard>/`, the shard number in decimal with at least two digits. */
const shardPrefix = (shard: number) => `s/${String(shard).padStart(2, "0")}/`

/** The shard's log segments, one immutable object per appended batch. */
export const logPrefix = (shard: number) => `${shardPrefix(shard)}log/`

/** The shard's checkpoint manifests, newest first in ascending key order. */
export const checkpointPrefix = (shard: number) => `${shardPrefix(shard)}cp/`

/** `s/<shard>/log/<offset>`, the offset as 16 hex digits so keys sort by offset. */
export const segmentKey: {
  (offset: bigint): (shard: number) => string
  (shard: number, offset: bigint): string
} = dual(2, (shard: number, offset: bigint) => `${logPrefix(shard)}${hex16(offset)}`)

/**
 * `s/<shard>/cp/<inverted offset>`, the offset subtracted from 2^64 - 1, so an
 * ascending listing limited to one key returns the newest checkpoint.
 */
export const checkpointKey: {
  (offset: bigint): (shard: number) => string
  (shard: number, offset: bigint): string
} = dual(
  2,
  (shard: number, offset: bigint) => `${checkpointPrefix(shard)}${hex16(LAST_OFFSET - offset)}`,
)

/** The offset a segment key names; none for any other key under the log prefix. */
export const segmentOffset: {
  (key: string): (shard: number) => Option.Option<bigint>
  (shard: number, key: string): Option.Option<bigint>
} = dual(2, (shard: number, key: string) =>
  key.startsWith(logPrefix(shard)) ? parseHex16(key.slice(logPrefix(shard).length)) : Option.none(),
)

/** The offset a checkpoint key names; none for any other key under the checkpoint prefix. */
export const checkpointOffset: {
  (key: string): (shard: number) => Option.Option<bigint>
  (shard: number, key: string): Option.Option<bigint>
} = dual(2, (shard: number, key: string) =>
  key.startsWith(checkpointPrefix(shard))
    ? Option.map(
        parseHex16(key.slice(checkpointPrefix(shard).length)),
        (inverted) => LAST_OFFSET - inverted,
      )
    : Option.none(),
)

/** `pages/<sha256>`, the hash of the stored bytes in lowercase hex. */
export const pageKey = (hash: string) => `${PAGES_PREFIX}${hash}`

/**
 * Lease objects live under `cluster/` (runner membership and shard locks) and
 * `gc/` (the collector's create-once lease). Segments use letters, digits and
 * `. _ % -` only, so every key is also a portable file name; no other key is
 * writable through the lease interface.
 */
export const isLeaseKey = (key: string) => LEASE_KEY.test(key)

/** A lease listing prefix: a lease namespace followed by whole path segments. */
export const isLeasePrefix = (prefix: string) => LEASE_PREFIX.test(prefix)
