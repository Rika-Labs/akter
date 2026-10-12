import { Effect, Schema } from "effect"
import { Hex, SchemaBinary } from "effect/encoding"
import { CorruptSegment } from "./errors.ts"
import { pageKey } from "./keys.ts"

/** The at-rest format this release writes and the only one it reads. */
export const FORMAT = 1

/** Lowercase hex SHA-256 of a page's stored bytes; the page's key. */
export const PageHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))

/**
 * One appended batch at `s/<shard>/log/<offset>`. `open` is the offset of the
 * writing lease's open segment and `writer` the process that holds it; together
 * they tell an owner's own earlier write from another owner's after a lost
 * response. The open segment itself has no entries and `open` equal to its offset.
 */
export const Segment = Schema.Struct({
  writer: Schema.String,
  open: Schema.BigInt,
  entries: Schema.Array(Schema.Uint8Array),
})

/** A decoded segment. */
export type Segment = typeof Segment.Type

/**
 * A checkpoint at `s/<shard>/cp/<inverted offset>`: the shard state through
 * `offset` lives in the named pages, and `nextDue` is the earliest pending timer
 * in epoch milliseconds, read when a stopped store must be woken.
 */
export const Manifest = Schema.Struct({
  offset: Schema.BigInt,
  statePages: Schema.Array(PageHash),
  indexPages: Schema.Array(PageHash),
  nextDue: Schema.optional(Schema.Finite),
})

/** A checkpoint manifest. */
export type Manifest = typeof Manifest.Type

/** `meta/store`: the store's id and shard count, fixed when the store is created. */
export const StoreMeta = Schema.Struct({
  format: Schema.Int,
  store: Schema.String,
  shards: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 })),
})

/** The store's identity record. */
export type StoreMeta = typeof StoreMeta.Type

const MetaJson = Schema.fromJsonString(StoreMeta)

const SegmentBinary = SchemaBinary.toCodec(Segment)

const ManifestBinary = SchemaBinary.toCodec(Manifest)

const MAGIC_A = 0x61

const MAGIC_K = 0x6b

/** Object kinds in the third byte of every binary object: segment, checkpoint, page. */
const Kind = { segment: 0x73, checkpoint: 0x63, page: 0x70 } as const

const corrupt = (key: string, reason: string) => CorruptSegment.make({ key, reason })

/** `a k <kind> <format>` then the body, so a reader names the format before decoding. */
const wrap = (kind: number, body: Uint8Array): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(body.length + 4)
  bytes.set([MAGIC_A, MAGIC_K, kind, FORMAT])
  bytes.set(body, 4)
  return bytes
}

const unwrap = (key: string, kind: number, bytes: Uint8Array) =>
  Effect.suspend(() => {
    if (bytes.length < 4 || bytes[0] !== MAGIC_A || bytes[1] !== MAGIC_K || bytes[2] !== kind)
      return Effect.fail(corrupt(key, "missing the object header"))
    if (bytes[3] !== FORMAT)
      return Effect.fail(
        corrupt(key, `format ${String(bytes[3])}; this release reads format ${String(FORMAT)}`),
      )
    return Effect.succeed(bytes.subarray(4))
  })

/** A segment's stored bytes. */
export const encodeSegment = (segment: Segment) =>
  Schema.encodeEffect(SegmentBinary)(segment).pipe(
    Effect.map((body) => wrap(Kind.segment, body)),
    Effect.orDie,
  )

/** Reads a segment stored at `key`. */
export const decodeSegment = (key: string) => (bytes: Uint8Array) =>
  unwrap(key, Kind.segment, bytes).pipe(
    Effect.flatMap((body) =>
      Schema.decodeEffect(SegmentBinary)(body.slice()).pipe(
        Effect.mapError((error) => corrupt(key, error.message)),
      ),
    ),
  )

/** A manifest's stored bytes. */
export const encodeManifest = (manifest: Manifest) =>
  Schema.encodeEffect(ManifestBinary)(manifest).pipe(
    Effect.map((body) => wrap(Kind.checkpoint, body)),
    Effect.orDie,
  )

/** Reads a manifest stored at `key`. */
export const decodeManifest = (key: string) => (bytes: Uint8Array) =>
  unwrap(key, Kind.checkpoint, bytes).pipe(
    Effect.flatMap((body) =>
      Schema.decodeEffect(ManifestBinary)(body.slice()).pipe(
        Effect.mapError((error) => corrupt(key, error.message)),
      ),
    ),
  )

/** `meta/store` as JSON, so operators and the control plane can read it without Akter. */
export const encodeMeta = (meta: StoreMeta) =>
  Schema.encodeEffect(MetaJson)(meta).pipe(
    Effect.map((json) => new TextEncoder().encode(json)),
    Effect.orDie,
  )

/** Reads `meta/store`, refusing a format this release does not know. */
export const decodeMeta = (key: string) => (bytes: Uint8Array) =>
  Schema.decodeEffect(MetaJson)(new TextDecoder().decode(bytes)).pipe(
    Effect.mapError((error) => corrupt(key, error.message)),
    Effect.filterOrFail(
      (meta) => meta.format === FORMAT,
      (meta) =>
        corrupt(key, `format ${String(meta.format)}; this release reads format ${String(FORMAT)}`),
    ),
  )

/** A page's stored bytes: the header, then the caller's bytes unchanged. */
export const encodePage = (payload: Uint8Array) => wrap(Kind.page, payload)

/** Lowercase hex SHA-256 of `bytes`. */
export const sha256 = (bytes: Uint8Array<ArrayBuffer>) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((digest) => Hex.encode(new Uint8Array(digest))),
  )

/** Reads a page stored under `hash`, checking the bytes hash to it. */
export const decodePage = (hash: string) => (bytes: Uint8Array<ArrayBuffer>) =>
  sha256(bytes).pipe(
    Effect.filterOrFail(
      (actual) => actual === hash,
      (actual) => corrupt(pageKey(hash), `bytes hash to ${actual}`),
    ),
    Effect.andThen(unwrap(pageKey(hash), Kind.page, bytes)),
  )
