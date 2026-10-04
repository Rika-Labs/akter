import { CommandLogEntry } from "@akter/cloud-api"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { toOpeningTail, toRecentTurns, toTailEntry } from "./mapping.ts"

const decode = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(JSON.stringify(input))

const entry = (fields: Record<string, Schema.Json>) => ({
  commandId: "v1.1791099825418.1791186225418.5979a62a-ca7e-48a3-82b3-fff071bcd715",
  at: "2026-10-03T14:02:16.998Z",
  durationMs: 4.1,
  address: "Order/ord_8f2c",
  command: "Charged",
  caller: { kind: "user", subject: "user:usr_1", source: null },
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
          commandId: "v1.1791099825418.1791186225418.5979a62a-ca7e-48a3-82b3-fff071bcd715",
          time: "14:02:16.998",
          took: "4.1 ms",
          actorType: "Order",
          key: "ord_8f2c",
          command: 'Charged { chargeId: "ch_3Q9xA2" }',
          caller: { kind: "user", subject: "user:usr_1", source: null },
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

  it("writes a turn the log holds no time, duration or payload for with dashes and a bare command", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const turn = yield* decode(
          CommandLogEntry,
          entry({ at: null, durationMs: null, payloadPreview: null, caller: null }),
        )
        const row = toTailEntry(4)(turn)
        expect(row).toMatchObject({ time: "—", took: "—", command: "Charged", caller: null })
        expect([row.time, row.took, row.command, row.detail].join(" ")).not.toMatch(
          /null|NaN|undefined/,
        )
      }),
    ))

  it("sorts untimed turns after timed ones, keeping the log's order among ties", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const turns = yield* Effect.forEach(
          [
            ["untimed-a", null],
            ["14:00:01", "2026-10-03T14:00:01.000Z"],
            ["untimed-b", null],
            ["14:00:03", "2026-10-03T14:00:03.000Z"],
            ["tie-first", "2026-10-03T14:00:02.000Z"],
            ["tie-second", "2026-10-03T14:00:02.000Z"],
            ["untimed-c", null],
          ] as const,
          ([command, at]) => decode(CommandLogEntry, entry({ command, at, payloadPreview: null })),
        )
        expect(toRecentTurns(turns).map((turn) => [turn.sequence, turn.command])).toEqual([
          [6, "14:00:03"],
          [5, "tie-first"],
          [4, "tie-second"],
          [3, "14:00:01"],
          [2, "untimed-a"],
          [1, "untimed-b"],
          [0, "untimed-c"],
        ])
        const untimed = turns.filter((turn) => turn.at === null)
        expect(toRecentTurns(untimed).map((turn) => turn.command)).toEqual([
          "untimed-a",
          "untimed-b",
          "untimed-c",
        ])
      }),
    ))
})
