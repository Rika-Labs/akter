import { Cause, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { VERSION_KEY } from "../state/migration.ts"
import { stateCodec } from "./codecs.ts"

const fields = {
  label: Schema.String,
  count: Schema.Finite,
  tags: Schema.Array(Schema.String),
  when: Schema.DateTimeUtcFromMillis,
  note: Schema.optionalKey(Schema.String),
}

const State = Schema.Struct(fields)

type State = typeof State.Type

const json = Schema.fromJsonString(Schema.toCodecJson(State))

const text = (state: State) => Effect.runSync(Schema.encodeEffect(json)(state))

/**
 * The rows as the whole state's JSON text holds each key: the text is parsed
 * back and each dirty key serialized on its own, a missing key as `null`.
 */
const expectedRows = (state: State, dirty: ReadonlyArray<string>, version: number) => {
  const parsed = Effect.runSync(
    Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
      text(state),
    ),
  )
  const rows: Array<readonly [string, string]> = dirty.map((key) => [
    key,
    JSON.stringify(parsed[key] ?? null),
  ])

  return version > 0 && dirty.length > 0 ? [...rows, [VERSION_KEY, String(version)]] : rows
}

describe("stateCodec.writes", () => {
  const state = Effect.runSync(
    Schema.decodeEffect(State)({
      label: 'quote " back\\slash \u2028 line é 𝄞',
      count: -0.000001,
      tags: ["", "\u0000"],
      when: 1_700_000_000_123,
    }),
  )

  it("writes each dirty key as the state's encoded JSON holds it, absent keys as null", () => {
    const codec = stateCodec({ fields, migrations: [], maxBytes: 10_000 })
    const dirty = ["label", "note", "when", "tags", "count"]

    expect(Effect.runSync(codec.writes(state, new Set(dirty)))).toEqual(
      expectedRows(state, dirty, 0),
    )
    expect(Effect.runSync(codec.writes(state, new Set(["when"])))).toEqual([
      ["when", "1700000000123"],
    ])
  })

  it("adds the version row only when a migrated state writes a key", () => {
    const codec = stateCodec({
      fields,
      migrations: [{ from: fields, to: fields, upcast: (value) => value }],
      maxBytes: 10_000,
    })

    expect(Effect.runSync(codec.writes(state, new Set(["count"])))).toEqual(
      expectedRows(state, ["count"], 1),
    )
    expect(Effect.runSync(codec.writes(state, new Set()))).toEqual([])
  })

  it("dies when the whole state's UTF-8 text passes maxStateBytes, even if no large key is dirty", () => {
    const bytes = new TextEncoder().encode(text(state)).byteLength
    const fits = stateCodec({ fields, migrations: [], maxBytes: bytes })
    const over = stateCodec({ fields, migrations: [], maxBytes: bytes - 1 })

    expect(Exit.isSuccess(Effect.runSyncExit(fits.writes(state, new Set(["count"]))))).toBe(true)

    const refused = Effect.runSyncExit(over.writes(state, new Set(["count"])))

    expect(Exit.isFailure(refused) && Cause.pretty(refused.cause)).toContain(
      "State exceeds policy.maxStateBytes",
    )
  })
})
