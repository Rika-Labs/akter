import { Crypto, Effect, Schema } from "effect"
import { type ActorRef, type Caller, System } from "./caller.ts"
import { parseChildId } from "./child.ts"

/** What a minted id is derived from: the minting parent, the command and position in its turn, and the child's actor type. */
export interface MintInput {
  /** The minting parent; a singleton parent's id is the empty string. */
  readonly parent: ActorRef
  readonly commandId: string
  /** How many mints the turn made before this one. */
  readonly ordinal: number
  /** The child's actor type. */
  readonly child: string
}

/**
 * The digest's domain string. It predates the Akter name and stays as it is,
 * because every minted id already stored was derived with it.
 */
const DOMAIN = "durable-actors/mint/v1"

const SINGLETON_ID = "singleton"

const utf8 = new TextEncoder()

const MINTED = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** True for the lowercase UUIDv8 form `turn.mint` produces. */
export const isMintedId = (id: string) => MINTED.test(id)

/** Length-prefixed UTF-8 fields the minted id digests, in order. */
export const mintPreimage = ({ parent, commandId, ordinal, child }: MintInput) => {
  const fields = [
    DOMAIN,
    parent.tenant,
    parent.actor,
    parent.id,
    commandId,
    String(ordinal),
    child,
  ].map((field) => utf8.encode(field))

  const bytes = new Uint8Array(fields.reduce((size, field) => size + 4 + field.byteLength, 0))
  const view = new DataView(bytes.buffer)
  let offset = 0

  for (const field of fields) {
    view.setUint32(offset, field.byteLength)
    bytes.set(field, offset + 4)
    offset += 4 + field.byteLength
  }

  return bytes
}

/** The UUIDv8 a parent turn mints for `child` at `ordinal`: the first 16 SHA-256 bytes of its preimage. */
export const deriveMintId = Effect.fnUntraced(function* (input: MintInput) {
  const digest = yield* (yield* Crypto.Crypto)
    .digest("SHA-256", mintPreimage(input))
    .pipe(Effect.orDie)

  const bytes = digest.slice(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x80
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
})

/**
 * True when `caller` is the framework's creating intent for the minted actor
 * `target`. A parent-placed target, whose parent type is `parent`, is minted
 * only by the parent its id names, and only its local part is derived. A
 * singleton parent digests an empty id, and its ref alone cannot tell it from
 * a keyed parent whose id is `singleton`, so both digests are accepted; one
 * actor type is never both.
 */
export const provesMint = Effect.fnUntraced(function* (
  caller: Caller,
  target: ActorRef,
  parent?: string,
) {
  if (
    !Schema.is(System)(caller) ||
    caller.source === "cron" ||
    caller.source === "workflow" ||
    caller.source === "job"
  )
    return false

  const { ref, mint } = caller

  if (ref === undefined || mint === undefined || ref.tenant !== target.tenant) return false

  const parts = parent === undefined ? undefined : parseChildId(target.id)

  if (parent !== undefined && (parts?.parent !== ref.id || ref.actor !== parent)) return false

  const id = parts?.local ?? target.id

  const derives = (minter: ActorRef) =>
    deriveMintId({
      parent: minter,
      commandId: mint.commandId,
      ordinal: mint.ordinal,
      child: target.actor,
    })

  if ((yield* derives(ref)) === id) return true

  return ref.id === SINGLETON_ID && (yield* derives({ ...ref, id: "" })) === id
})
