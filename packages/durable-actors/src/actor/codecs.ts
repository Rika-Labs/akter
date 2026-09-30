import { Effect, Schema } from "effect"
import type { AnyMember, DeclaredError, ValueSchema } from "../members/command.ts"
import { type StateMigration, VERSION_KEY } from "../state/migration.ts"

type StateFields = Readonly<Record<string, ValueSchema>>

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
  const input = valueCodec(member.input)
  const output = valueCodec(member.output)
  const errorSchema = Schema.Union(member.errors)

  const error: Schema.Codec<DeclaredError["Type"], string> = Schema.fromJsonString(
    Schema.toCodecJson(errorSchema),
  )

  return {
    encodeInput: Schema.encodeEffect(input),
    decodeInput: Schema.decodeEffect(input),
    encodeOutput: Schema.encodeEffect(output),
    decodeOutput: Schema.decodeEffect(output),
    isError: Schema.is(errorSchema),
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
      state: (yield* decodeJsonState(current).pipe(Effect.orDie)) as Record<string, unknown>,
      upcast: storedVersion < version && rows.length > 0,
    }
  })

  const writes = Effect.fnUntraced(function* (
    current: Record<string, unknown>,
    dirty: ReadonlySet<string>,
  ) {
    const text = yield* encode(current as typeof schema.Type).pipe(Effect.orDie)

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
  const roundTrip = (state: Record<string, unknown>) =>
    Effect.flatMap(encode(state as typeof schema.Type).pipe(Effect.orDie), (text) =>
      decode(text).pipe(Effect.orDie),
    ) as Effect.Effect<Record<string, unknown>>

  const equivalences = Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, Schema.toEquivalence(field)]),
  )

  return { schema, version, decodeStored, writes, roundTrip, equivalences }
}

export type StateCodec = ReturnType<typeof stateCodec>
