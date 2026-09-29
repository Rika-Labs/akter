import { Effect, Schema } from "effect"
import type { StateMigration } from "../state/migration.ts"
import type { ValueSchema } from "./command.ts"

type Fields = Readonly<Record<string, ValueSchema>>

/**
 * An event's or effect's migration chain: every step since version 0, or,
 * once no stored value needs the first `from` versions, the steps after them.
 * Declaring the dropped count keeps every later version number unchanged.
 */
export type PayloadMigrations =
  | ReadonlyArray<StateMigration>
  | { readonly from: number; readonly steps: ReadonlyArray<StateMigration> }

export interface PayloadOptions {
  readonly migrations?: PayloadMigrations
  /**
   * The version new values are written at. During a rolling deploy that adds
   * a step, runners that don't know the step yet must still read every new
   * value, so the first release writes the previous version and needs that
   * step's `downcast`. Defaults to the chain's current version.
   */
  readonly writeVersion?: number
}

/** A validated chain: stored versions `first..current` decode, and new values are written at `writeVersion`. */
export interface PayloadChain {
  readonly first: number
  readonly current: number
  readonly writeVersion: number
  /** Step `i` upcasts version `first + i` to `first + i + 1`. */
  readonly steps: ReadonlyArray<StateMigration>
}

/** A stored value its chain cannot read; every read treats it as a defect, never a skip. */
export class PayloadError extends Schema.TaggedError<PayloadError>()("PayloadError", {
  message: Schema.String,
}) {}

const sameFields = (left: Fields, right: Fields) => {
  const keys = Object.keys(left)

  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  )
}

const isVersion = (value: number) => Number.isSafeInteger(value) && value >= 0

/**
 * Validates a chain against the declared fields, as the state chain is: each
 * `to` has the next `from`'s fields and the last `to` has the declared ones.
 * Fields compare key by key, so a step may restate them in a new object.
 */
const chainOf = (label: string, fields: Fields, options: PayloadOptions | undefined) => {
  const declared = options?.migrations ?? []
  const { from: first, steps } = Array.isArray(declared)
    ? { from: 0, steps: declared as ReadonlyArray<StateMigration> }
    : (declared as { readonly from: number; readonly steps: ReadonlyArray<StateMigration> })

  if (!isVersion(first)) throw new Error(`${label} migrations.from must be a non-negative integer`)

  for (let index = 1; index < steps.length; index++)
    if (!sameFields(steps[index - 1]!.to, steps[index]!.from))
      throw new Error(`${label} migration ${index} must start from the previous migration's result`)

  if (steps.length > 0 && !sameFields(steps.at(-1)!.to, fields))
    throw new Error(`${label}'s last migration must produce its declared fields`)

  for (const step of steps)
    if ("_tag" in step.from || "_tag" in step.to)
      throw new Error(`${label} migrations must not name _tag; the tag never changes`)

  const current = first + steps.length
  const writeVersion = options?.writeVersion ?? current

  if (!isVersion(writeVersion) || writeVersion < first || writeVersion > current)
    throw new Error(`${label} writeVersion must be a version from ${first} to ${current}`)

  for (let version = writeVersion; version < current; version++)
    if (steps[version - first]!.downcast === undefined)
      throw new Error(
        `${label} writes version ${writeVersion}, so migration ${version - first} needs a downcast`,
      )

  return { first, current, writeVersion, steps } satisfies PayloadChain
}

const chains = new WeakMap<object, PayloadChain>()

const NO_CHAIN: PayloadChain = { first: 0, current: 0, writeVersion: 0, steps: [] }

/** Records a class's chain when the class is built; an invalid chain throws there. */
export const declareChain = (
  schema: object,
  label: string,
  fields: Fields,
  options: PayloadOptions | undefined,
) => {
  chains.set(schema, chainOf(label, fields, options))
}

/**
 * The chain of an event or effect class. `class X extends Actor.Event<X>()(…)`
 * is a subclass of the class the chain was declared on, so lookup follows the
 * prototype chain; a class declared without one reads and writes version 0.
 */
export const payloadChain = (schema: object): PayloadChain => {
  for (let current: object | null = schema; current !== null;) {
    const chain = chains.get(current)

    if (chain !== undefined) return chain
    current = Object.getPrototypeOf(current) as object | null
  }

  return NO_CHAIN
}

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Encodes and decodes one tagged class's stored values, which carry the tag
 * in `_tag` and their version beside them. Values at the current version take
 * the class's own codec; older ones pass through each later step first.
 */
export const payloadCodec = (
  schema: ValueSchema & { readonly Type: { readonly _tag: string } },
  tag: string,
) => {
  const chain = payloadChain(schema)
  const json = Schema.toCodecJson(schema)
  const codec = Schema.fromJsonString(json)
  const encodeCurrent = Schema.encodeEffect(codec)
  const decodeCurrent = Schema.decodeEffect(codec)
  const encodeCurrentJson = Schema.encodeEffect(json)
  const decodeCurrentJson = Schema.decodeUnknownEffect(json)

  const steps = chain.steps.map((step) => {
    const from = Schema.toCodecJson(Schema.Struct(step.from))
    const to = Schema.toCodecJson(Schema.Struct(step.to))

    return {
      step,
      decodeFrom: Schema.decodeUnknownEffect(from),
      encodeFrom: Schema.encodeUnknownEffect(from),
      decodeTo: Schema.decodeUnknownEffect(to),
      encodeTo: Schema.encodeUnknownEffect(to),
    }
  })

  const failure = (version: number, cause: unknown) =>
    PayloadError.make({
      message: `Stored ${tag} at payload version ${version} does not decode: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    })

  const fields = Effect.fnUntraced(function* (value: Schema.Json) {
    if (!isObject(value) || value["_tag"] !== tag)
      return yield* Effect.fail(new Error(`expected an object tagged ${tag}`))
    const { _tag, ...rest } = value

    return rest
  })

  // Upcasts a stored value to the current version's JSON, still encoded.
  const upcastJson = (text: string, version: number) =>
    Effect.gen(function* () {
      if (version > chain.current)
        return yield* PayloadError.make({
          message: `Stored ${tag} has payload version ${version}, newer than this code's chain (${chain.current}); roll forward`,
        })

      if (version < chain.first)
        return yield* PayloadError.make({
          message: `Stored ${tag} has payload version ${version}, older than this code's chain (${chain.first})`,
        })

      let value: unknown = yield* fields(yield* decodeJson(text))

      for (const { step, decodeFrom, encodeTo } of steps.slice(version - chain.first)) {
        const previous = yield* decodeFrom(value)
        const next = yield* Effect.try({
          try: () => step.upcast(previous),
          catch: (cause) => cause,
        })
        value = yield* encodeTo(next)
      }

      return yield* decodeCurrentJson({ ...(value as object), _tag: tag })
    }).pipe(
      Effect.mapError((cause) => (cause instanceof PayloadError ? cause : failure(version, cause))),
    )

  return {
    chain,
    /** Encodes a value at the chain's write version. */
    encode: (value: unknown) =>
      chain.writeVersion === chain.current
        ? encodeCurrent(value as never).pipe(
            Effect.map((text) => ({ value: text, version: chain.current })),
          )
        : Effect.gen(function* () {
            let encoded: unknown = yield* fields(
              (yield* encodeCurrentJson(value as never)) as Schema.Json,
            )

            for (let version = chain.current; version > chain.writeVersion; version--) {
              const { step, decodeTo, encodeFrom } = steps[version - 1 - chain.first]!
              const next = yield* decodeTo(encoded)
              encoded = yield* encodeFrom(step.downcast!(next))
            }

            return {
              value: yield* encodeJson({ ...(encoded as object), _tag: tag } as Schema.Json),
              version: chain.writeVersion,
            }
          }),
    /** Decodes a stored value written at `version` into the current class. */
    decode: (text: string, version: number) =>
      version === chain.current
        ? decodeCurrent(text).pipe(Effect.mapError((cause) => failure(version, cause)))
        : upcastJson(text, version),
    /** A stored value as the current version encodes it; unchanged when it is already current. */
    upcast: (text: string, version: number) =>
      version === chain.current
        ? Effect.succeed(text)
        : upcastJson(text, version).pipe(
            Effect.flatMap((decoded) => encodeCurrent(decoded as never)),
            Effect.mapError((cause) =>
              cause instanceof PayloadError ? cause : failure(version, cause),
            ),
          ),
  }
}

export type PayloadCodec = ReturnType<typeof payloadCodec>

/** One event or effect class an actor type reads or writes, as the startup check sees it. */
export interface PayloadDeclaration {
  readonly actorType: string
  readonly kind: "event" | "effect"
  readonly tag: string
  readonly chain: PayloadChain
  /** Whether this layer writes new values of the class, so it records and heartbeats its write version. */
  readonly writes: boolean
}

/** What `durable payloads check` and `clear` need of an actor definition. */
export interface DefinitionPayloads {
  readonly declarations: ReadonlyArray<PayloadDeclaration>
  readonly keepEventsMs: number
  readonly commandTimeoutMs: number
}

export const definitionPayloads = new WeakMap<object, DefinitionPayloads>()
