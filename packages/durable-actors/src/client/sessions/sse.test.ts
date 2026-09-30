import { Effect, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  ActorError,
  ActorUnavailable,
  NotCreated,
  TransportError,
  Unauthorized,
  withRetryAfter,
} from "../../errors/actor.ts"
import { RetentionGap, UnknownCursor } from "../../errors/events.ts"
import { actorErrorBody } from "../../protocol/wire.ts"
import { undecodableFailure } from "../transport.ts"
import { feedStream } from "./feed.ts"
import { readEvents } from "./sse.ts"
import { subscription } from "./stream.ts"
import { watchStream } from "./watch.ts"

const encoder = new TextEncoder()

const test = <E>(name: string, body: () => Effect.Effect<void, E>) =>
  it(name, () => Effect.runPromise(body()))

/** A body that sends exactly these chunks, then closes unless `hold` keeps it open; `cancelled` records a cancel. */
const body = (chunks: ReadonlyArray<Uint8Array>, hold = false) => {
  const cancelled = { value: false }

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(chunk)

      if (!hold) controller.close()
    },
    cancel: () => {
      cancelled.value = true
    },
  })

  return { stream, cancelled }
}

const sse = (chunks: ReadonlyArray<string>) => bytes(chunks.map((chunk) => encoder.encode(chunk)))

const bytes = (chunks: ReadonlyArray<Uint8Array>) =>
  new Response(body(chunks).stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

const refusal = (status: number, json: Schema.Json) =>
  new Response(JSON.stringify(json), { status })

const read = (response: Response, idleMs?: number) =>
  readEvents({ response, refused: () => undecodableFailure(), idleMs }).pipe(Stream.runCollect)

const messages = (chunks: ReadonlyArray<string>) => read(sse(chunks))

/** The served JSON body of `reason`, with a server-drawn `retryAfter` when given. */
const envelope = (reason: ActorError["reason"], retryAfter?: number) => {
  const error = ActorError.make({ reason })

  return actorErrorBody(retryAfter === undefined ? error : withRetryAfter(retryAfter)(error))
}

const encodeCursorError = Schema.encodeEffect(
  Schema.toCodecJson(Schema.Union([RetentionGap, UnknownCursor])),
)

/** Every value a session delivers and the failure it ended with, if any. */
const drain = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const values: Array<A> = []

    const error = yield* stream.pipe(
      Stream.runForEach((value) => Effect.sync(() => values.push(value))),
      Effect.flip,
      Effect.option,
    )

    return { values, error: Option.getOrUndefined(error) }
  })

describe("readEvents", () => {
  test("keeps the event name when a CRLF is split across chunks", () =>
    Effect.gen(function* () {
      expect(yield* messages(["event: result\r", "\ndata: 1\r\n\r\n"])).toEqual([
        { event: "result", id: undefined, data: "1" },
      ])
    }))

  test("reads CR-only line ends, including a CR that ends a chunk before another field", () =>
    Effect.gen(function* () {
      expect(yield* messages(["id: 7\revent: result\r", "data: 1\r\r"])).toEqual([
        { event: "result", id: "7", data: "1" },
      ])
    }))

  test("strips a leading BOM and joins UTF-8 split between chunks", () =>
    Effect.gen(function* () {
      const whole = encoder.encode("\uFEFFevent: a\ndata: é\n\n")

      expect(yield* read(bytes([whole.slice(0, 19), whole.slice(19)]))).toEqual([
        { event: "a", id: undefined, data: "é" },
      ])
    }))

  test("reports an id only where a message introduced it: inherited, empty, and NUL ids are none", () =>
    Effect.gen(function* () {
      expect(
        yield* messages([
          "id: 1\nevent: Posted\ndata: a\n\n",
          "event: end\ndata: inherited\n\n",
          "id: 2\nevent: end\ndata: domain\n\n",
          "id: 3\u0000\nevent: x\ndata: nul\n\n",
          "id:\nevent: x\ndata: empty\n\n",
        ]),
      ).toEqual([
        { event: "Posted", id: "1", data: "a" },
        { event: "end", id: undefined, data: "inherited" },
        { event: "end", id: "2", data: "domain" },
        { event: "x", id: undefined, data: "nul" },
        { event: "x", id: undefined, data: "empty" },
      ])
    }))

  test("accepts a message past Effect's 10 MiB default, since served watch and stream output has no budget", () =>
    Effect.gen(function* () {
      const data = "x".repeat(10 * 1024 * 1024 + 1)
      const [message] = yield* messages([`data: ${data.slice(0, 5)}`, `${data.slice(5)}\n\n`])

      expect(message?.data.length).toBe(data.length)
    }))

  test("ends an idle body and cancels it, keeping what arrived first", () =>
    Effect.gen(function* () {
      const held = body([encoder.encode("data: 1\n\n")], true)

      expect(yield* read(new Response(held.stream, { status: 200 }), 30)).toEqual([
        { event: "message", id: undefined, data: "1" },
      ])
      expect(held.cancelled.value).toBe(true)
    }))

  test("delivers the message a chunk completes even when the body fails right after it", () => {
    let pulls = 0

    const cut = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulls += 1

        if (pulls > 1) return

        return Promise.resolve().then(() => {
          controller.enqueue(encoder.encode("id: 1\nevent: a\ndata: 1\n\n"))
          controller.error(new Error("connection lost"))
        })
      },
    })

    return Effect.gen(function* () {
      const delivered: Array<string | undefined> = []

      const failure = yield* readEvents({
        response: new Response(cut, { status: 200 }),
        refused: () => undecodableFailure(),
        idleMs: 1_000,
      }).pipe(
        Stream.runForEach((message) => Effect.sync(() => delivered.push(message.id))),
        Effect.flip,
      )

      expect(delivered).toEqual(["1"])
      expect(failure).toMatchObject({
        reason: TransportError.make({ code: "network", retryable: true }),
      })
    })
  })

  test("fails with the refusal of a non-200 body", () =>
    Effect.gen(function* () {
      const failure = yield* readEvents({
        response: new Response("nope", { status: 404 }),
        refused: (text, status) =>
          ActorError.make({
            reason: TransportError.make({ code: "status", status, retryable: text === "nope" }),
          }),
      }).pipe(Stream.runCollect, Effect.flip)

      expect(failure).toMatchObject({ reason: { status: 404, retryable: true } })
    }))
})

class Posted extends Schema.TaggedClass<Posted>()("Posted", { text: Schema.String }) {}

class Ended extends Schema.TaggedClass<Ended>()("end", { text: Schema.String }) {}

const encodeEvent = Schema.encodeEffect(Schema.toCodecJson(Schema.Union([Posted, Ended])))

/** One feed message as the server writes it: the event's cursor as `id` and its tag as the event name. */
const feedEvent = (id: string, event: Posted | Ended) =>
  encodeEvent(event).pipe(
    Effect.map(
      (json) =>
        `id: ${id}\nevent: ${event._tag}\ndata: ${JSON.stringify({ event: json, commandId: "c", timestamp: 1 })}\n\n`,
    ),
  )

/** A session's last message, with no `id` line of its own. */
const terminal = <E>(body: Effect.Effect<Schema.Json, E>) =>
  body.pipe(Effect.map((json) => `event: end\ndata: ${JSON.stringify(json)}\n\n`))

/** Answers each open with the next response and records the position it was opened from. */
const scripted = (responses: ReadonlyArray<() => Response>) => {
  const opened: Array<{ readonly from: string | undefined; readonly at: number }> = []

  return {
    opened,
    open: (from: string | undefined) =>
      Effect.sync(() => {
        opened.push({ from, at: performance.now() })
        const next = responses[opened.length - 1]

        if (next === undefined) throw new Error(`unexpected open ${opened.length}`)

        return next()
      }),
  }
}

describe("feedStream", () => {
  test("delivers a domain event named end, then ends at the terminal end, which inherits that event's id", () =>
    Effect.gen(function* () {
      const first = [
        yield* feedEvent("1", Ended.make({ text: "domain" })),
        yield* RetentionGap.make({ cursor: "1" }).pipe(encodeCursorError, terminal),
      ]

      const script = scripted([() => sse(first)])

      const { values, error } = yield* drain(
        feedStream({ open: script.open, event: Ended, options: { after: "0" } }),
      )

      expect(values.map((entry) => [entry.cursor, entry.event.text])).toEqual([["1", "domain"]])
      expect(error).toEqual(RetentionGap.make({ cursor: "1" }))
      expect(script.opened).toHaveLength(1)
    }))

  test("reopens after the last delivered cursor when the body closes", () =>
    Effect.gen(function* () {
      const first = [
        yield* feedEvent("4", Posted.make({ text: "a" })),
        yield* feedEvent("5", Posted.make({ text: "b" })),
      ]

      const second = [
        yield* feedEvent("6", Posted.make({ text: "c" })),
        yield* UnknownCursor.make({ cursor: "6" }).pipe(encodeCursorError, terminal),
      ]

      const script = scripted([() => sse(first), () => sse(second)])

      const { values, error } = yield* drain(
        feedStream({ open: script.open, event: Posted, options: { after: "3" } }),
      )

      expect(values.map((entry) => entry.cursor)).toEqual(["4", "5", "6"])
      expect(error).toEqual(UnknownCursor.make({ cursor: "6" }))
      expect(script.opened.map((open) => open.from)).toEqual(["3", "5"])
    }))

  test("refreshes an expired credential once, and again only after a delivery", () =>
    Effect.gen(function* () {
      const body = yield* Unauthorized.make({ code: "expired" }).pipe(envelope)
      const expired = () => refusal(401, body)
      const event = yield* feedEvent("1", Posted.make({ text: "a" }))
      const script = scripted([expired, () => sse([event]), expired, expired])

      const { values, error } = yield* drain(
        feedStream({ open: script.open, event: Posted, options: {} }),
      )

      expect(values.map((entry) => entry.cursor)).toEqual(["1"])
      expect(script.opened).toHaveLength(4)
      expect(error).toMatchObject({ reason: Unauthorized.make({ code: "expired" }) })
    }))

  test("waits at least the server's retryAfter before reopening", () =>
    Effect.gen(function* () {
      const unavailable = yield* envelope(ActorUnavailable.make({ cause: undefined }), 300)
      const gap = yield* RetentionGap.make({ cursor: "0" }).pipe(encodeCursorError, terminal)

      const script = scripted([() => refusal(503, unavailable), () => sse([gap])])

      yield* drain(feedStream({ open: script.open, event: Posted, options: {} }))

      expect(script.opened[1]!.at - script.opened[0]!.at).toBeGreaterThanOrEqual(295)
    }))

  test("stops at once when aborted while waiting to reopen", () => {
    const controller = new AbortController()

    return Effect.gen(function* () {
      const unavailable = yield* envelope(ActorUnavailable.make({ cause: undefined }), 10_000)
      const script = scripted([() => refusal(503, unavailable)])
      const started = performance.now()

      yield* Effect.sleep("30 millis").pipe(
        Effect.andThen(Effect.sync(() => controller.abort())),
        Effect.forkDetach,
      )

      const outcome = yield* drain(
        feedStream({ open: script.open, event: Posted, options: { signal: controller.signal } }),
      )

      expect(performance.now() - started).toBeLessThan(2_000)
      expect(outcome).toEqual({ values: [], error: undefined })
      expect(script.opened).toHaveLength(1)
    })
  })
})

describe("watchStream", () => {
  test("reopens from the greatest version any result carried, not the last one", () =>
    Effect.gen(function* () {
      const versions: Array<string | undefined> = []

      const notCreated = yield* NotCreated.make({}).pipe(envelope, terminal)

      const responses = [
        () => sse(["id: 7\nevent: result\ndata: 1\n\n", "id: 3\nevent: result\ndata: 2\n\n"]),
        () => sse([notCreated]),
      ]

      const { values, error } = yield* drain(
        watchStream({
          decode: (json) => Effect.succeed(json),
          declared: () => Option.none(),
          token: () => "5",
          options: {},
          open: (version) =>
            Effect.sync(() => {
              versions.push(version)

              return responses[versions.length - 1]!()
            }),
        }),
      )

      expect(values).toEqual([1, 2])
      expect(versions).toEqual(["5", "7"])
      expect(error).toMatchObject({ reason: NotCreated.make({}) })
    }))
})

describe("subscription", () => {
  const subscribe = (response: () => Response) => {
    let opened = 0

    const stream = subscription({
      member: { output: Schema.Int } as never,
      declared: () => Option.none(),
      options: {},
      open: () =>
        Effect.sync(() => {
          opened += 1

          return response()
        }),
    })

    return { stream, opened: () => opened }
  }

  test("finishes at a null end", () =>
    Effect.gen(function* () {
      const run = subscribe(() =>
        sse(["event: element\ndata: 1\n\n", "event: end\ndata: null\n\n"]),
      )

      expect(yield* drain(run.stream)).toEqual({ values: [1], error: undefined })
    }))

  test("is never resumed: a body cut without end fails with a retryable network error", () =>
    Effect.gen(function* () {
      const run = subscribe(() => sse(["event: element\ndata: 1\n\n"]))
      const { values, error } = yield* drain(run.stream)

      expect(values).toEqual([1])
      expect(error).toMatchObject({
        reason: TransportError.make({ code: "network", retryable: true }),
      })
      expect(Schema.is(ActorError)(error) && error.isRetryable).toBe(true)
      expect(run.opened()).toBe(1)
    }))
})
