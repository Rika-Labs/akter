import { Effect, Schema, type Stream } from "effect"
import type { AnyMember, DeclaredError, ValueSchema } from "../members/command.ts"
import { type StateMigration, VERSION_KEY } from "../state/migration.ts"

type StateFields = Readonly<Record<string, ValueSchema>>

/** A value some member schema decoded; the adapters pass it between codecs and handlers unchanged. */
export type Decoded = ValueSchema["Type"]

/** A declared failure: a value of some member's `error` schema. */
export type Failure = DeclaredError["Type"]

/** An actor's decoded state, keyed by field. */
export type StateValue = Readonly<Record<string, Decoded>>

/**
 * A handler, workflow body, or executor once its layer has erased its member
 * types: the phase adapters decode its payload, provide its services, and
 * encode its result with the member's own codecs.
 */
export type Handler = (payload: Decoded) => Effect.Effect<Decoded, Failure>

/** A stream member's handler once its layer has erased its member types. */
export type StreamHandler = (payload: Decoded) => Stream.Stream<Decoded, Failure>

const utf8 = new TextEncoder()

const decodeStoredVersion = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
)

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const decodeJsonObject = Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))

/** The runtime's encoding of one value of `schema`: a JSON object holding it under `value`. */
export const valueCodec = (
  schema: ValueSchema,
): Schema.Codec<{ readonly value: unknown }, string> =>
  Schema.fromJsonString(Schema.toCodecJson(Schema.Struct({ value: schema })))

/**
 * A member's payload, result, and declared-error codecs, compiled once per
 * member: building one per call recompiles its schema, which costs more than
 * the value it encodes. Handles, turns, queries, streams, workflows, and the
 * served view all use this one bundle.
 */
export const memberCodecs = (member: AnyMember) => {
  const payload = valueCodec(member.payload)
  const success = valueCodec(member.success)

  const error: Schema.Codec<DeclaredError["Type"], string> = Schema.fromJsonString(
    Schema.toCodecJson(member.error),
  )

  return {
    encodePayload: Schema.encodeEffect(payload),
    decodePayload: Schema.decodeEffect(payload),
    encodeSuccess: Schema.encodeEffect(success),
    decodeSuccess: Schema.decodeEffect(success),
    isError: Schema.is(member.error),
    encodeError: Schema.encodeEffect(error),
    decodeError: Schema.decodeEffect(error),
  }
}

export type MemberCodecs = ReturnType<typeof memberCodecs>

const upcastStep = (step: StateMigration, stored: Schema.Json) =>
  Schema.decodeEffect(Schema.toCodecJson(Schema.Struct(step.from)))(stored).pipe(
    Effect.flatMap((previous) =>
      Schema.encodeUnknownEffect(Schema.toCodecJson(Schema.Struct(step.to)))(step.upcast(previous)),
    ),
    Effect.orDie,
  )

/**
 * An actor's state codec. Stored rows are upcast through the migration chain
 * when read; an actor with no rows starts at the current version, and a read
 * that upcast reports it so the turn rewrites every key at the current
 * version. Otherwise a turn writes only its changed keys.
 */
export const stateCodec = ({
  fields,
  migrations,
  maxBytes,
}: {
  readonly fields: StateFields
  readonly migrations: ReadonlyArray<StateMigration>
  readonly maxBytes: number
}) => {
  const version = migrations.length
  const schema = Schema.Struct(fields)
  const decodeJsonState = Schema.decodeEffect(Schema.toCodecJson(schema))
  const json = Schema.fromJsonString(Schema.toCodecJson(schema))
  const encode = Schema.encodeEffect(json)
  const decode = Schema.decodeEffect(json)

  const decodeStored = Effect.fnUntraced(function* (
    rows: ReadonlyArray<readonly [string, string]>,
  ) {
    const stored: Record<string, Schema.Json> = {}
    let storedVersion = rows.length === 0 ? version : 0

    for (const [key, value] of rows)
      if (key === VERSION_KEY) storedVersion = yield* decodeStoredVersion(value).pipe(Effect.orDie)
      else stored[key] = yield* decodeJson(value).pipe(Effect.orDie)

    if (storedVersion > version)
      return yield* Effect.die(new Error(`Stored state version ${storedVersion} is unknown`))

    let current: Schema.Json = stored

    for (const step of migrations.slice(storedVersion)) current = yield* upcastStep(step, current)

    return {
      state: (yield* decodeJsonState(current).pipe(Effect.orDie)) as StateValue,
      upcast: storedVersion < version && rows.length > 0,
    }
  })

  const writes = Effect.fnUntraced(function* (current: StateValue, dirty: ReadonlySet<string>) {
    const text = yield* encode(current).pipe(Effect.orDie)

    if (utf8.encode(text).byteLength > maxBytes)
      return yield* Effect.die(new Error("State exceeds policy.maxStateBytes"))

    const encoded = yield* decodeJsonObject(text).pipe(Effect.orDie)
    const rows: Array<readonly [string, string]> = []

    for (const key of dirty)
      rows.push([key, yield* encodeJson(encoded[key] ?? null).pipe(Effect.orDie)])

    if (dirty.size > 0 && version > 0) rows.push([VERSION_KEY, String(version)])

    return rows
  })

  /** A decoded copy of `state` validated by the schema, so mutating the input cannot hide a change. */
  const roundTrip = (state: StateValue): Effect.Effect<StateValue> =>
    Effect.flatMap(encode(state).pipe(Effect.orDie), (text) => decode(text).pipe(Effect.orDie))

  const equivalences = Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, Schema.toEquivalence(field)]),
  )

  return { schema, version, decodeStored, writes, roundTrip, equivalences }
}

export type StateCodec = ReturnType<typeof stateCodec>
