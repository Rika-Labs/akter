import { ConnectionsSummary } from "@akter/cloud-api"
import { ConnectionsPage } from "./model.ts"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { toConnectionsPage } from "./mapping.ts"

const decode = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(JSON.stringify(input))

describe("connections mapping", () => {
  it("maps counts, sorts the history oldest first and renames per-type fields", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const summary = yield* decode(ConnectionsSummary, {
          open: 18_233,
          parked: 12_904,
          sseStreams: 1_140,
          feedSubscribers: 3_402,
          replayGaps: 2,
          openVersusParked: [
            { at: "2026-10-03T10:30:00.000Z", open: 90, parked: 40 },
            { at: "2026-10-03T10:00:00.000Z", open: 80, parked: 30 },
          ],
          byActorType: [{ actorType: "Cart", open: 5_102, parked: 4_991, sse: 7 }],
        })
        expect(toConnectionsPage(summary)).toEqual(
          ConnectionsPage.make({
            sockets: 18_233,
            parked: 12_904,
            streams: 1_140,
            subscribers: 3_402,
            replayGaps: 2,
            hours: ["10:00", "10:30"],
            open: [80, 90],
            parkedSeries: [30, 40],
            byType: [{ actorType: "Cart", sockets: 5_102, parked: 4_991, streams: 7 }],
          }),
        )
      }),
    ))
})
