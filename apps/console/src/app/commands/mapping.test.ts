import { CommandLogEntry } from "@akter/cloud-api"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { toOpeningTail, toRecentTurns, toTailEntry } from "./mapping.ts"

const decode = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(JSON.stringify(input))

const entry = (fields: Record<string, Schema.Json>) => ({
  commandId: "v1.1791100936998.1791187336998.6f1c2a9e-4b7d-4c1e-9a3f-2d8e5b7c1a04",
  at: "2026-10-03T14:02:16.998Z",
  durationMs: 4.1,
  address: "Order/ord_8f2c",
  command: "Charged",
  caller: { kind: "user", subject: "user:usr_ada", source: null },
  payloadPreview: '{ chargeId: "ch_3Q9xA2" }',
  outcome: "ok",
  errorTag: null,
  ...fields,
})

describe("command tail mapping", () => {
  it("writes an ok turn with the payload after the command and the time to the millisecond", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const turn = yield* decode(CommandLogEntry, entry({}))
        expect(toTailEntry(9)(turn)).toEqual({
          sequence: 9,
          time: "14:02:16.998",
          took: "4.1 ms",
          actorType: "Order",
          key: "ord_8f2c",
          command: 'Charged { chargeId: "ch_3Q9xA2" }',
          result: "ok",
          detail: "ok",
        })
      }),
    ))

  it("names an error by its typed tag, a replay as replayed, and leaves an empty payload off", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const failed = yield* decode(
          CommandLogEntry,
          entry({
            outcome: "error",
            errorTag: "AlreadyPlaced",
            payloadPreview: "",
            durationMs: 1500,
          }),
        )
        const replayed = yield* decode(CommandLogEntry, entry({ outcome: "replayed" }))
        const untagged = yield* decode(CommandLogEntry, entry({ outcome: "error" }))
        expect(toTailEntry(0)(failed)).toMatchObject({
          result: "error",
          detail: "AlreadyPlaced",
          command: "Charged",
          took: "1.5 s",
        })
        expect(toTailEntry(0)(replayed)).toMatchObject({ result: "replayed", detail: "replayed" })
        expect(toTailEntry(0)(untagged).detail).toBe("error")
      }),
    ))

  it("numbers a page so the newest turn is first and has the highest sequence", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const turns = yield* Effect.forEach(["14:00:02", "14:00:03", "14:00:01"], (time) =>
          decode(CommandLogEntry, entry({ at: `2026-10-03T${time}.000Z`, command: time })),
        )
        const recent = toRecentTurns(turns)
        expect(recent.map((turn) => [turn.sequence, turn.time])).toEqual([
          [2, "14:00:03.000"],
          [1, "14:00:02.000"],
          [0, "14:00:01.000"],
        ])
        expect(
          toOpeningTail({ entries: [], next: 41, paused: true, filter: "Order" })(recent),
        ).toEqual({ entries: recent, next: 3, paused: true, filter: "Order" })
        expect(
          toOpeningTail({ entries: recent, next: 3, paused: false, filter: "all" })([]).next,
        ).toBe(0)
      }),
    ))
})
