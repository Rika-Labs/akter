import { BunCrypto } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Context, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { HttpRouter } from "effect/http"
import { TestClock } from "effect/testing"
import { Actor, User } from "../../index.ts"
import { InternalActors } from "../actors.ts"
import { Actors, Auth, Database, Inspector } from "../index.ts"
import {
  liveRecorder,
  type LiveRecorder,
  MAX_RECORDED_TENANTS,
  MAX_STREAMS,
  MAX_TENANT_STREAMS,
  payloadPreview,
  PREVIEW_INPUT_CHARACTERS,
  STREAM_BUFFER,
  STREAM_GRACE_MS,
  STREAM_RING,
  StreamMessage,
  type StreamSource,
} from "./live.ts"

const encoded = (value: Schema.Json) => JSON.stringify({ value })

const source = (seq: number, overrides: Partial<StreamSource> = {}): StreamSource => ({
  commandId: `v1.c${seq}`,
  atMs: seq,
  durationMs: 1,
  actorType: "Order",
  actorId: `o-${seq}`,
  command: "Place",
  callerKey: '["User","u"]',
  failed: false,
  payload: encoded({ n: seq }),
  failure: undefined,
  ...overrides,
})

const publishAll = (recorder: LiveRecorder, tenant: string, from: number, to: number) =>
  Effect.sync(() => {
    for (let seq = from; seq <= to; seq++) recorder.publish(tenant, 0, () => source(seq))
  })

/** Runs a stream in the background, collecting what it sends, once its slot is taken. */
const consume = (recorder: LiveRecorder, stream: Stream.Stream<StreamMessage>, open: number) =>
  Effect.gen(function* () {
    const received: Array<StreamMessage> = []
    const fiber = yield* Stream.runForEach(stream, (message) =>
      Effect.sync(() => received.push(message)),
    ).pipe(Effect.forkChild)

    while (recorder.streams() < open) yield* Effect.yieldNow

    return { received, fiber }
  })

const commands = (received: ReadonlyArray<StreamMessage>) =>
  received.flatMap((message) => (StreamMessage.$is("command")(message) ? [message.entry] : []))

/** Waits until a background stream has received `count` commands. */
const settled = (received: ReadonlyArray<StreamMessage>, count: number) =>
  Effect.gen(function* () {
    while (commands(received).length < count) yield* Effect.yieldNow
  })

describe("payload previews", () => {
  it("redacts a top-level string, sensitive keys at any depth, named values and personal keys and values", () => {
    expect(payloadPreview(encoded("hunter2"))).toBe('"[redacted]"')
    expect(payloadPreview(encoded(42))).toBe("42")

    expect(
      payloadPreview(
        encoded({
          user: "ada",
          pwd: "p1",
          dob: "1990-01-01",
          homeAddress: "1 Main St",
          iban: "DE89",
          clientIp: "10.0.0.1",
        }),
      ),
    ).toBe(
      '{"user":"ada","pwd":"[redacted]","dob":"[redacted]","homeAddress":"[redacted]","iban":"[redacted]","clientIp":"[redacted]"}',
    )
    expect(
      payloadPreview(
        encoded({
          headers: [
            { name: "Authorization", value: "Bearer abc.def" },
            { name: "Accept", value: "text/plain" },
          ],
        }),
      ),
    ).toBe(
      '{"headers":[{"name":"Authorization","value":"[redacted]"},{"name":"Accept","value":"text/plain"}]}',
    )
    expect(payloadPreview(encoded({ nested: { profile: { secret: "s", nick: "n" } } }))).toBe(
      '{"nested":{"profile":{"secret":"[redacted]","nick":"n"}}}',
    )
    expect(payloadPreview(encoded({ nested: { secretAnswer: "blue", nick: "n" } }))).toBe(
      '{"nested":{"secretAnswer":"[redacted]","nick":"n"}}',
    )
    expect(payloadPreview(encoded({ "ada@example.com": { plan: "pro" }, ok: true }))).toBe(
      '{"[redacted]":"[redacted]","ok":true}',
    )
    expect(payloadPreview(encoded({ note: "write to ada@example.com", to: "10.1.2.3" }))).toBe(
      '{"note":"[redacted]","to":"[redacted]"}',
    )
    expect(payloadPreview(encoded({ zipped: "yes", description: "fine" }))).toBe(
      '{"zipped":"yes","description":"fine"}',
    )
  })

  it("bounds the preview and reads no payload past its input limit", () => {
    const wide = payloadPreview(
      encoded({ items: Array.from({ length: 50 }, (_, index) => "x".repeat(40) + index) }),
    )

    expect(wide?.length).toBeLessThanOrEqual(256)
    expect(wide).toContain(`"${"x".repeat(32)}…"`)
    expect(payloadPreview(encoded({ text: "y".repeat(PREVIEW_INPUT_CHARACTERS) }))).toBeNull()
    expect(payloadPreview("not json")).toBeNull()
    expect(payloadPreview("{}")).toBeNull()
  })
})

describe("live recorder", () => {
  it.effect("refuses a fifth stream of a tenant and the sixty-fifth of a runner", () =>
    Effect.gen(function* () {
      const recorder = liveRecorder({ startedAtMs: 0, epoch: "e" })

      for (let open = 1; open <= MAX_TENANT_STREAMS; open++)
        yield* consume(recorder, recorder.subscribe("t0", {}, undefined), open)

      expect(recorder.full("t0")).toBe(true)
      expect(recorder.full("t1")).toBe(false)

      const refused = yield* Stream.runCollect(recorder.subscribe("t0", {}, undefined))
      expect(refused.map((message) => message._tag)).toEqual(["gap"])
      expect(recorder.streams()).toBe(MAX_TENANT_STREAMS)

      for (let open = MAX_TENANT_STREAMS + 1; open <= MAX_STREAMS; open++)
        yield* consume(
          recorder,
          recorder.subscribe(`t${Math.ceil(open / MAX_TENANT_STREAMS)}`, {}, undefined),
          open,
        )

      expect(recorder.full("elsewhere")).toBe(true)
    }),
  )

  it.effect(
    "takes no slot for a stream interrupted before it starts, and gives one back however a stream ends",
    () =>
      Effect.gen(function* () {
        const recorder = liveRecorder({ startedAtMs: 0, epoch: "e" })
        const early = yield* Stream.runDrain(recorder.subscribe("t", {}, undefined)).pipe(
          Effect.forkChild,
        )
        yield* Fiber.interrupt(early)
        expect(recorder.streams()).toBe(0)

        const { fiber } = yield* consume(recorder, recorder.subscribe("t", {}, undefined), 1)
        expect(recorder.streams()).toBe(1)
        yield* Fiber.interrupt(fiber)
        expect(recorder.streams()).toBe(0)
      }),
  )

  it.effect(
    "ends a stream that falls a whole buffer behind with a gap, after what it buffered",
    () =>
      Effect.gen(function* () {
        const recorder = liveRecorder({ startedAtMs: 0, epoch: "e" })
        const { received, fiber } = yield* consume(
          recorder,
          recorder.subscribe("t", {}, undefined),
          1,
        )

        yield* publishAll(recorder, "t", 1, STREAM_BUFFER + 5)
        yield* Fiber.join(fiber)

        expect(commands(received).map((entry) => entry.seq)).toEqual(
          Array.from({ length: STREAM_BUFFER }, (_, index) => index + 1),
        )
        expect(received.at(-1)?._tag).toBe("gap")
        expect(recorder.streams()).toBe(0)
      }),
  )

  it.effect(
    "resumes from the ring after an id it still holds, and sends a gap for one it no longer reaches or another epoch's",
    () =>
      Effect.gen(function* () {
        const recorder = liveRecorder({ startedAtMs: 0, epoch: "e" })
        const held = yield* consume(recorder, recorder.subscribe("t", {}, undefined), 1)
        const total = STREAM_RING + 44

        yield* publishAll(recorder, "t", 1, total)
        yield* settled(held.received, total)

        const epoch = commands(held.received)[0]!.id.split(".")[0]
        const resumed = yield* consume(
          recorder,
          recorder.subscribe("t", {}, `${epoch}.${total - 10}`),
          2,
        )

        yield* settled(resumed.received, 10)

        expect(commands(resumed.received).map((entry) => entry.seq)).toEqual(
          Array.from({ length: 10 }, (_, index) => total - 9 + index),
        )

        const evicted = yield* Stream.runCollect(recorder.subscribe("t", {}, `${epoch}.10`))
        expect(evicted.map((message) => message._tag)).toEqual(["gap"])

        const elsewhere = yield* Stream.runCollect(recorder.subscribe("t", {}, "other-9.3"))
        expect(elsewhere.map((message) => message._tag)).toEqual(["gap"])
      }),
  )

  it.effect("previews a payload only for a stream that takes the command", () =>
    Effect.gen(function* () {
      const recorder = liveRecorder({ startedAtMs: 0, epoch: "e" })
      const orders = yield* consume(
        recorder,
        recorder.subscribe("t", { actorType: "Order" }, undefined),
        1,
      )

      yield* Effect.sync(() => {
        recorder.publish("t", 0, () => source(1))
        recorder.publish("t", 0, () => source(2, { actorType: "Cart" }))
      })
      yield* settled(orders.received, 1)

      const epoch = commands(orders.received)[0]!.id.split(".")[0]
      const all = yield* consume(recorder, recorder.subscribe("t", {}, `${epoch}.0`), 2)
      yield* settled(all.received, 2)

      expect(commands(all.received).map((entry) => [entry.seq, entry.payloadPreview])).toEqual([
        [1, '{"n":1}'],
        [2, null],
      ])
    }),
  )

  it.effect(
    "keeps a quiet tenant's ring through the grace only, then sweeps it and starts a new epoch",
    () =>
      Effect.gen(function* () {
        const recorder = liveRecorder({ startedAtMs: 0, epoch: "e" })
        const first = yield* consume(recorder, recorder.subscribe("t", {}, undefined), 1)

        yield* publishAll(recorder, "t", 1, 3)
        yield* settled(first.received, 3)
        yield* Fiber.interrupt(first.fiber)
        const last = commands(first.received).at(-1)!.id

        expect(recorder.watched()).toBe(1)

        const resumed = yield* consume(recorder, recorder.subscribe("t", {}, last), 1)
        yield* publishAll(recorder, "t", 4, 4)
        yield* settled(resumed.received, 1)
        expect(commands(resumed.received).map((entry) => entry.seq)).toEqual([4])
        yield* Fiber.interrupt(resumed.fiber)

        yield* TestClock.adjust(STREAM_GRACE_MS + 1)
        yield* Stream.runCollect(recorder.subscribe("u", {}, "x-1.1"))
        expect(recorder.watched()).toBe(0)

        const late = yield* Stream.runCollect(recorder.subscribe("t", {}, last))
        expect(late.map((message) => message._tag)).toEqual(["gap"])
      }),
  )

  it("drops the least recently active tenant past its cap, and then counts every tenant from its own first turn", () => {
    const recorder = liveRecorder({ startedAtMs: 1_000, epoch: "e" })

    for (let tenant = 0; tenant < MAX_RECORDED_TENANTS; tenant++)
      recorder.record(`t${tenant}`, "Order", "Place", 3, 2_000 + tenant)

    expect(recorder.activity("t0", "Order", "1h", 10_000)?.since).toBe(1_000)

    recorder.record("late", "Order", "Place", 3, 9_000)

    expect(recorder.activity("t0", "Order", "1h", 10_000)).toBeUndefined()
    expect(recorder.activity("never", "Order", "1h", 10_000)).toBeUndefined()
    expect(recorder.activity("late", "Order", "1h", 10_000)?.since).toBe(9_000)
    expect(recorder.activity("t1", "Order", "1h", 10_000)).toMatchObject({
      since: 1_000,
      commands: [{ command: "Place", count: 1 }],
    })
  })

  it("counts each command per hour for a week and per minute for an hour, reusing a slot once its interval passed", () => {
    const recorder = liveRecorder({ startedAtMs: 0, epoch: "e" })
    const hour = 3_600_000

    recorder.record("t", "Order", "Place", 3, 10 * hour)
    recorder.record("t", "Order", "Place", 3, 10 * hour + 1)
    recorder.record("t", "Order", "Cancel", 700, 20 * hour)
    recorder.record("t", "Order", "Place", 3, 178 * hour)

    expect(recorder.activity("t", "Order", "7d", 178 * hour + 5)?.commands).toEqual([
      { command: "Cancel", count: 1, perSecond: 1 / ((168 * hour - hour + 5) / 1000) },
      { command: "Place", count: 1, perSecond: 1 / ((168 * hour - hour + 5) / 1000) },
    ])
    expect(recorder.latency("t", "Order", "7d", 178 * hour + 5)).toMatchObject({
      count: 2,
      p50Ms: 5,
      p99Ms: 700,
    })
    expect(recorder.activity("t", "Order", "1h", 178 * hour + 5)?.commands).toEqual([
      { command: "Place", count: 1, perSecond: 1 / ((59 * 60_000 + 5) / 1000) },
    ])
  })
})

const Ping = Actor.command("Ping")

const Pinged = Actor.make("LivePinged", { key: Schema.String, api: { Ping } })

const operators = Auth.make(() =>
  Effect.succeed({ tenant: "default", caller: User.make({ subject: "op" }) }),
)

describe("live runtime", () => {
  it.live("keeps no recorder in a runtime until the inspector is mounted", () =>
    Effect.gen(function* () {
      const runtime = yield* Layer.build(
        Pinged.toLayer(Effect.succeed({ Ping: () => Effect.void })).pipe(
          Layer.provideMerge(Actors.layer()),
          Layer.provideMerge(Database.pglite()),
          Layer.provideMerge(BunCrypto.layer),
        ),
      )
      const internal = Context.get(runtime, InternalActors)

      yield* Effect.flatMap(Pinged.get("a"), (pinged) => pinged.Ping()).pipe(
        Effect.provideContext(runtime),
      )
      expect(internal.live.recorder()).toBeUndefined()

      const web = HttpRouter.toWebHandler(
        Inspector.serve({ auth: operators }).pipe(Layer.provide(Layer.succeedContext(runtime))),
        { disableLogger: true },
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))
      yield* Effect.promise(() => web.handler(new Request("http://inspector/inspector/overview")))

      const recorder = Option.fromNullishOr(internal.live.recorder())
      expect(Option.isSome(recorder)).toBe(true)

      yield* Effect.flatMap(Pinged.get("a"), (pinged) => pinged.Ping()).pipe(
        Effect.provideContext(runtime),
      )
      expect(
        Option.getOrThrow(recorder).activity(
          "default",
          "LivePinged",
          "1h",
          yield* Clock.currentTimeMillis,
        )?.commands,
      ).toEqual([{ command: "Ping", count: 1, perSecond: expect.any(Number) }])
    }).pipe(Effect.scoped),
  )
})
