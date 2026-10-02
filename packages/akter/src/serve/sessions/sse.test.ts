import { Effect, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { readEvents } from "../../client/sessions/sse.ts"
import { undecodableFailure } from "../../client/transport.ts"
import { ActorError, SessionEnded } from "../../errors/actor.ts"
import { message, failureJson } from "./sse.ts"
import { streamResponse } from "./stream.ts"

const test = <E>(name: string, body: () => Effect.Effect<void, E>) =>
  it(name, () => Effect.runPromise(body()))

const decoder = new TextDecoder()

class Closed extends Schema.TaggedError<Closed>()("Closed", {}) {}

/** A served SSE body as the client reads it. */
const readBack = (text: string) =>
  readEvents({
    response: new Response(text, { status: 200 }),
    refused: () => undecodableFailure(),
  }).pipe(Stream.runCollect)

describe("served SSE frames", () => {
  test("writes an id, the event name, and one JSON data line, and no id line for none", () =>
    Effect.gen(function* () {
      expect(yield* message({ event: "Posted", data: { text: "a\nb" }, id: "12" })).toBe(
        'id: 12\nevent: Posted\ndata: {"text":"a\\nb"}\n\n',
      )
      expect(yield* message({ event: "end", data: null })).toBe("event: end\ndata: null\n\n")
    }))

  test("keeps a domain event named end distinct from the terminal end that follows it", () =>
    Effect.gen(function* () {
      const failure = ActorError.make({
        reason: SessionEnded.make({ cause: "Terminated", resync: false }),
      })

      const text = [
        yield* message({ event: "end", data: { text: "domain" }, id: "1" }),
        yield* message({ event: "end", data: yield* failureJson(failure) }),
      ].join("")

      const read = yield* readBack(text)

      expect(read.map((each) => [each.event, each.id])).toEqual([
        ["end", "1"],
        ["end", undefined],
      ])
    }))

  test("ends a stream response with null after its elements, and with the failure's body otherwise", () =>
    Effect.gen(function* () {
      const text = (elements: Stream.Stream<string, { readonly failure: string }>) =>
        streamResponse(elements).pipe(
          Stream.map((bytes) => decoder.decode(bytes)),
          Stream.mkString,
        )

      expect(yield* text(Stream.make('{"value":1}', "{}"))).toBe(
        "event: element\ndata: 1\n\nevent: element\ndata: null\n\nevent: end\ndata: null\n\n",
      )

      const declared = yield* Closed.make({}).pipe(
        Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(Closed))),
      )

      expect(yield* text(Stream.fail({ failure: declared }))).toBe(
        'event: end\ndata: {"_tag":"Closed"}\n\n',
      )
    }))
})
