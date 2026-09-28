import { Context, Effect, Schema } from "effect"

export const CommandId = Schema.String.check(
  Schema.isPattern(
    /^v1\.[1-9]\d{0,14}\.[1-9]\d{0,14}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
)

export const CurrentCommandId = Context.Reference<string | undefined>(
  "durable-actors/CurrentCommandId",
  {
    defaultValue: () => undefined,
  },
)

export const commandTimes = (id: string) => {
  const parts = CommandId.make(id).split(".")

  return { issuedAt: Number(parts[1]), expiresAt: Number(parts[2]) }
}

/** How a connection handler's command calls get ids that stay stable across frame redelivery. */
export interface ConnectionCommands {
  /** Hex of 32 random bytes the holder minted at open; never stored or shown to handlers. */
  readonly secret: string
  readonly seq: number
  readonly issuedAt: number
  readonly expiresAt: number
}

/** Mints the id of one call from a connection handler, given its target actor key and command tag. */
export const CurrentConnectionCommands = Context.Reference<
  ((target: string, command: string) => Effect.Effect<string>) | undefined
>("durable-actors/CurrentConnectionCommands", { defaultValue: () => undefined })

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const fromHex = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))

/**
 * The id of the `index`th call a connection handler makes while handling frame
 * `seq`: HMAC-SHA256 of the call under the connection's secret, shaped as a
 * version-4 UUID so it matches every other command id.
 */
export const connectionCommandId = ({
  commands,
  index,
  target,
  command,
}: {
  readonly commands: ConnectionCommands
  readonly index: number
  readonly target: string
  readonly command: string
}) =>
  Effect.gen(function* () {
    const subtle = globalThis.crypto.subtle

    const key = yield* Effect.promise(() =>
      subtle.importKey("raw", fromHex(commands.secret), { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
      ]),
    )

    // Length-prefixed parts, so no two calls encode to the same message.
    const message = new TextEncoder().encode(
      [String(commands.seq), String(index), target, command]
        .map((part) => `${part.length}:${part}`)
        .join(""),
    )

    const digest = new Uint8Array(yield* Effect.promise(() => subtle.sign("HMAC", key, message)))
    const bytes = digest.slice(0, 16)
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const raw = hex(bytes)

    const uuid = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`

    return `v1.${commands.issuedAt}.${commands.expiresAt}.${uuid}`
  })

export const connectionSecret = (bytes: Uint8Array) => hex(bytes)
