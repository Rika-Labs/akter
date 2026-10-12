import { Effect, Random, Result } from "effect"
import { InvalidCommandId } from "../contract/errors.ts"
import { Digest } from "./digest.ts"

/** How long a client command id lives: fixed, not configurable. */
export const commandLifetime = 600_000

/** How far a client's `issuedAt` may lead the owner's admission time. */
export const futureBound = 60_000

/** A parsed client command id. */
export interface ExternalId {
  readonly id: string
  readonly issuedAt: number
  readonly expiresAt: number
}

const uuid = (bytes: Uint8Array, version: number): string => {
  const b = bytes.slice(0, 16)
  b[6] = ((b[6] ?? 0) & 0x0f) | (version << 4)
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
  const text = Digest.bytesToHex(b)
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`
}

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const uuidAny = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const external = /^v(\d+)\.(\d+)\.(\d+)\.(.+)$/

/**
 * A derived id: the UUIDv8 of the SHA-256 of its parts. No client can mint one, so a derived id a
 * client presents is refused, and every derivation from the same parent and ordinal agrees.
 */
const derive = (...parts: ReadonlyArray<string | number>): string =>
  uuid(Digest.sha256(parts.join("\u0000")), 8)

type Refusal = typeof InvalidCommandId.Type

/**
 * Validates a client id at admission time `now`, in the contract's order: unparsable, then
 * version (a derived id or another version), then `future`, then `window`. Expiry is checked by
 * the caller against the same `now`, after this.
 */
const parse = (id: string, now: number): Result.Result<ExternalId, Refusal> => {
  const refuse = (code: Refusal["code"]) => Result.fail(InvalidCommandId.make({ commandId: id, code }))
  if (uuidAny.test(id)) return refuse("version")
  const match = external.exec(id)
  if (match === null) return refuse("malformed")
  const [, version, issued, expires, rest = ""] = match
  if (version !== "1") return refuse("version")
  if (!uuidV4.test(rest)) return refuse("malformed")
  const issuedAt = Number(issued)
  const expiresAt = Number(expires)
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt < issuedAt)
    return refuse("malformed")
  if (issuedAt > now + futureBound)
    return Result.fail(InvalidCommandId.make({ commandId: id, code: "future", now }))
  if (expiresAt - issuedAt > commandLifetime) return refuse("window")
  return Result.succeed({ id, issuedAt, expiresAt })
}

/** Mints a client id issued at `now` from the ambient `Random`, so a simulation's ids follow its seed. */
const mint = (now: number): Effect.Effect<string> =>
  Effect.map(
    Effect.forEach(Array.from({ length: 4 }), () => Random.nextIntBetween(0, 0x1_0000_0000)),
    (words) => {
      const bytes = new Uint8Array(16)
      const view = new DataView(bytes.buffer)
      words.forEach((word, index) => view.setUint32(index * 4, word >>> 0))
      return `v1.${now}.${now + commandLifetime}.${uuid(bytes, 4)}`
    },
  )

/** Command ids: client ids parsed and minted, derived ids computed. */
export const CommandIds = { derive, parse, mint }
