import { Schema } from "effect"

/** Hex SHA-256 of a content's bytes, computed by the server, never supplied by a client. */
const ContentHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))

/**
 * A reference to uploaded content. `grant` is the capability: it is bound to
 * the tenant, the hash, and the size, and expires. Knowing only the hash grants nothing.
 */
export const ContentRef = Schema.Struct({
  hash: ContentHash,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  grant: Schema.String,
})

/** An uploaded content's hash, size, and grant. */
export type ContentRef = typeof ContentRef.Type

/** One reference an actor holds under a content blob. */
export interface ContentEntry {
  readonly name: string
  readonly hash: string
  readonly size: number
}
