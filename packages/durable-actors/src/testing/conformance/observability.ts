import {
  Cause,
  Crypto,
  Effect,
  Exit,
  Layer,
  Match,
  Metric,
  Option,
  Predicate,
  Schema,
  type Scope,
  Tracer,
} from "effect"
import { PrometheusMetrics } from "effect/unstable/observability"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Actors } from "../../index.ts"
import { DefectLog } from "../../runtime/telemetry/defects.ts"
import { Metrics } from "../../runtime/telemetry/metrics.ts"
import { TelemetrySampler } from "../../runtime/telemetry/sampler.ts"
import { SpanNames } from "../../runtime/telemetry/spans.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"

class Ticked extends Actor.Event<Ticked>()("ObsTicked", { n: Schema.Int }) {}

class Ping extends Actor.effect<Ping>()("ObsPing", { input: { body: Schema.String } }) {}

class Orphan extends Actor.effect<Orphan>()("ObsOrphan", { input: { body: Schema.String } }) {}

const Bump = Actor.command("Bump", { input: Schema.Int, output: Schema.Int })

const Break = Actor.command("Break")

const Send = Actor.command("Send", { input: Schema.String })

const Perform = Actor.command("Perform", { input: Schema.String })

const Strand = Actor.command("Strand", { input: Schema.String })

const Orphanage = Actor.make("ObsOrphanage", {
  key: Schema.String,
  effects: [Orphan],
  api: { Strand },
  policy: { effects: { ObsOrphan: { retry: { times: 0 } } } },
})

const Receive = Actor.command("Receive", { input: Schema.String })

const Author = Actor.make("ObsAuthor", {
  key: Schema.String,
  state: Actor.state({ n: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  events: [Ticked],
  effects: [Ping],
  api: { Bump, Break, Send, Perform },
  policy: {
    keepEvents: "1 hour",
    holdEventsForSubscribers: "1 hour",
    effects: { ObsPing: { retry: { times: 0 } } },
  },
})

const TickDelivery = Actor.Delivery({ source: Author, events: [Ticked] })

const OnTick = Actor.command("OnTick", { input: TickDelivery })

const Watch = Actor.subscription("ObsWatch", {
  source: Author,
  events: [Ticked],
  handler: OnTick,
  route: () => "w1",
})

const Watcher = Actor.make("ObsWatcher", {
  key: Schema.String,
  api: {},
  internal: { OnTick },
  subscriptions: [Watch],
})

const Inbox = Actor.make("ObsInbox", { key: Schema.String, api: { Receive } })

/** Receives die while this holds, so their intent stays in the outbox. */
const failing = { receive: false }

const live = Layer.mergeAll(
  Author.toLayer(
    Effect.succeed({
      Bump: Effect.fnUntraced(function* (by: number) {
        const turn = yield* Author.Turn
        yield* turn.state.set({ n: turn.state.n + by })
        yield* turn.emit(Ticked.make({ n: turn.state.n }))

        return turn.state.n
      }),
      Break: () => Effect.die(new Error("gauge snapped")),
      Send: Effect.fnUntraced(function* (to: string) {
        yield* Author.Turn
        yield* (yield* Inbox.intents(to)).Receive("hello")
      }),
      Perform: Effect.fnUntraced(function* (body: string) {
        yield* (yield* Author.Turn).perform(Ping.make({ body }))
      }),
    }),
  ),
  Author.toEffectLayer(Effect.succeed({ ObsPing: () => Effect.void })),
  Orphanage.toLayer(
    Effect.succeed({
      Strand: Effect.fnUntraced(function* (body: string) {
        yield* (yield* Orphanage.Turn).perform(Orphan.make({ body }))
      }),
    }),
  ),
  Watcher.toLayer(
    Effect.succeed({ OnTick: () => Effect.die(new Error("watcher cannot keep up")) }),
  ),
  Inbox.toLayer(
    Effect.succeed({
      Receive: () =>
        Effect.suspend(() => (failing.receive ? Effect.die(new Error("inbox full")) : Effect.void)),
    }),
  ),
)

/** Every span the runtime started, read after it ended. */
const recordingTracer = () => {
  const spans: Array<Tracer.Span> = []

  const tracer = Tracer.make({
    span: (options) => {
      const span = Tracer.nativeTracer.span(options)
      spans.push(span)

      return span
    },
  })

  return { tracer, spans }
}

interface Telemetry {
  readonly spans: ReadonlyArray<Tracer.Span>
}

/**
 * A runtime of its own on a fresh database, with a recording tracer and a
 * metric registry no other case writes, so every span and value is this case's.
 */
const withTelemetry = <A, E>(
  environment: ConformanceEnvironment,
  body: (
    telemetry: Telemetry,
  ) => Effect.Effect<
    A,
    E,
    Actors | ActorTest | DefectLog | TelemetrySampler | SqlClient.SqlClient | Scope.Scope
  >,
) =>
  environment.run(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      const database = yield* environment.freshDatabase
      const recorder = recordingTracer()
      const registry: Metric.MetricRegistry = new Map()

      failing.receive = false

      const services = yield* Layer.buildWithMemoMap(
        live.pipe(
          Layer.provideMerge(
            ActorTest.layer({
              database,
              observability: { sampleEvery: "1 hour" },
            }),
          ),
          Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
          Layer.provide(Layer.succeed(Tracer.Tracer, recorder.tracer)),
          Layer.provide(Layer.succeed(Metric.MetricRegistry, registry)),
          Layer.orDie,
        ),
        yield* Layer.makeMemoMap,
        yield* Effect.scope,
      )

      return yield* body({ spans: recorder.spans }).pipe(
        Effect.provideContext(services),
        Effect.provideService(Tracer.Tracer, recorder.tracer),
        Effect.provideService(Metric.MetricRegistry, registry),
      )
    }),
  )

const ended = (span: Tracer.Span) => Predicate.isTagged(span.status, "Ended")

/** The pretty cause a span ended with, when it ended in failure. */
const failureOf = (span: Tracer.Span): Option.Option<string> =>
  Match.value(span.status).pipe(
    Match.tag("Ended", ({ exit }) =>
      Exit.isFailure(exit) ? Option.some(Cause.pretty(exit.cause)) : Option.none(),
    ),
    Match.orElse(() => Option.none()),
  )

const parentId = (span: Tracer.Span) =>
  Option.match(span.parent, { onNone: () => undefined, onSome: (parent) => parent.spanId })

const named = (spans: ReadonlyArray<Tracer.Span>, name: string) =>
  spans.filter((span) => span.name === name && ended(span))

const withAttribute = (
  spans: ReadonlyArray<Tracer.Span>,
  name: string,
  key: string,
  value: string | number | boolean,
) => named(spans, name).filter((span) => span.attributes.get(key) === value)

/** Whether `ancestor` is on `span`'s parent chain among the recorded spans. */
const descends = (
  spans: ReadonlyArray<Tracer.Span>,
  span: Tracer.Span,
  ancestor: Tracer.Span,
): boolean => {
  const parent = parentId(span)

  if (parent === undefined) return false

  if (parent === ancestor.spanId) return true
  const next = spans.find((candidate) => candidate.spanId === parent)

  return next !== undefined && descends(spans, next, ancestor)
}

/** The value of one series: a counter's count, a gauge's value, or a histogram's count. */
const valueOf = (name: string, attributes: Readonly<Record<string, string>>) =>
  Effect.map(Metric.snapshot, (snapshots) => {
    const found = snapshots.find(
      (snapshot) =>
        snapshot.id === name &&
        Object.entries(attributes).every(
          ([key, value]) =>
            (snapshot.attributes as Readonly<Record<string, string>> | undefined)?.[key] === value,
        ),
    )

    if (found === undefined) return undefined

    const state = found.state as { readonly count?: number; readonly value?: number }

    return state.value ?? state.count
  })

const sample = Effect.gen(function* () {
  yield* (yield* TelemetrySampler).sample
})

const execute = (sql: SqlClient.SqlClient, statement: string) =>
  sql.unsafe(statement).pipe(Effect.asVoid, Effect.orDie)

/** Observability cases: turn and admission spans, defect logs, and metrics correlate with the command id. */
export const observabilityConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "names the turn span durable-actors.<Actor>/<Command> and correlates it with the command id (O1)",
    run: ({ expect, environment }) =>
      withTelemetry(environment, ({ spans }) =>
        Effect.gen(function* () {
          const author = yield* Author.get("a1")
          const commandId = yield* (yield* Actors).mintCommandId

          expect(yield* author.Bump(2).pipe(Actor.commandId(commandId))).toBe(2)

          const [turn] = withAttribute(
            spans,
            SpanNames.turn("ObsAuthor", "Bump"),
            "command.id",
            commandId,
          )

          expect(turn).not.toBe(undefined)
          expect(turn!.name).toBe("durable-actors.ObsAuthor/Bump")
          expect(turn!.kind).toBe("server")
          expect(Object.fromEntries(turn!.attributes)).toMatchObject({
            "actor.type": "ObsAuthor",
            "actor.id": "a1",
            "command.name": "Bump",
            "command.id": commandId,
            "caller.kind": "System",
            "turn.trigger": "command",
            "turn.outcome": "success",
            "turn.replayed": false,
            "actor.generation": "1",
          })
          expect(Option.isNone(failureOf(turn!))).toBe(true)

          const [admission] = withAttribute(spans, SpanNames.admission, "command.id", commandId)

          expect(admission?.traceId).toBe(turn!.traceId)
          expect(descends(spans, turn!, admission!)).toBe(true)

          const commits = named(spans, SpanNames.commit).filter((span) =>
            descends(spans, span, turn!),
          )

          expect(commits.length).toBe(1)

          for (const span of [admission!, turn!, commits[0]!])
            for (const value of span.attributes.values()) expect(value).not.toBe("alice")
        }),
      ),
  },
  {
    name: "answers a retried command id from its receipt in the admission span, without a second turn",
    run: ({ expect, environment }) =>
      withTelemetry(environment, ({ spans }) =>
        Effect.gen(function* () {
          const author = yield* Author.get("a2")
          const commandId = yield* (yield* Actors).mintCommandId

          yield* author.Bump(1).pipe(Actor.commandId(commandId))
          expect(yield* author.Bump(1).pipe(Actor.commandId(commandId))).toBe(1)

          const admissions = withAttribute(spans, SpanNames.admission, "command.id", commandId)

          expect(admissions.map((span) => span.attributes.get("admission.replayed"))).toEqual([
            undefined,
            true,
          ])
          expect(
            withAttribute(spans, SpanNames.turn("ObsAuthor", "Bump"), "command.id", commandId)
              .length,
          ).toBe(1)
          expect(
            yield* valueOf("durable-actors.receipts.written", { actor_type: "ObsAuthor" }),
          ).toBe(1)
          expect(
            yield* valueOf("durable-actors.receipts.replayed", { actor_type: "ObsAuthor" }),
          ).toBe(1)
        }),
      ),
  },
  {
    name: "fails a defect's turn span with its cause, keeps it in the defect log, and counts it",
    run: ({ expect, environment }) =>
      withTelemetry(environment, ({ spans }) =>
        Effect.gen(function* () {
          const author = yield* Author.get("a3")
          const commandId = yield* (yield* Actors).mintCommandId

          expect(
            Exit.isFailure(yield* author.Break().pipe(Actor.commandId(commandId), Effect.exit)),
          ).toBe(true)

          const [turn] = withAttribute(
            spans,
            SpanNames.turn("ObsAuthor", "Break"),
            "command.id",
            commandId,
          )

          expect(turn!.attributes.get("turn.outcome")).toBe("defect")
          expect(Option.getOrElse(failureOf(turn!), () => "")).toContain("gauge snapped")

          const defects = yield* (yield* DefectLog).list({ actorType: "ObsAuthor" })

          expect(defects).toMatchObject([
            {
              span: "durable-actors.ObsAuthor/Break",
              traceId: turn!.traceId,
              spanId: turn!.spanId,
              actorType: "ObsAuthor",
              actorId: "a3",
              command: "Break",
              commandId,
              trigger: "command",
            },
          ])
          expect(defects[0]!.cause).toContain("gauge snapped")
          expect(yield* (yield* DefectLog).list({ actorType: "ObsInbox" })).toEqual([])
          expect(
            yield* (yield* DefectLog).list({
              actorType: "ObsAuthor",
              sinceMs: defects[0]!.atMs + 1,
            }),
          ).toEqual([])
          expect(
            yield* valueOf("durable-actors.turns", { actor_type: "ObsAuthor", outcome: "defect" }),
          ).toBe(1)
        }),
      ),
  },
  {
    name: "names the relay's intent delivery, the receiver's turn, and the effect attempt",
    run: ({ expect, environment }) =>
      withTelemetry(environment, ({ spans }) =>
        Effect.gen(function* () {
          const test = yield* ActorTest
          const author = yield* Author.get("a4")

          yield* author.Send("i1")
          yield* author.Perform("p")
          yield* test.advance(0)

          const [delivery] = withAttribute(spans, SpanNames.relayIntent, "actor.id", "i1")

          expect(delivery?.kind).toBe("producer")
          expect(delivery!.attributes.get("command.name")).toBe("Receive")
          expect(delivery!.attributes.get("relay.attempt")).toBe(1)

          const [received] = named(spans, SpanNames.turn("ObsInbox", "Receive"))

          expect(received!.attributes.get("turn.trigger")).toBe("actor")
          expect(received!.attributes.get("caller.kind")).toBe("System")
          expect(received!.attributes.get("command.id")).toBe(
            delivery!.attributes.get("command.id"),
          )
          expect(descends(spans, received!, delivery!)).toBe(true)

          const [attempt] = named(spans, SpanNames.effect("ObsAuthor", "ObsPing"))

          expect(Object.fromEntries(attempt!.attributes)).toMatchObject({
            "actor.type": "ObsAuthor",
            "actor.id": "a4",
            "effect.name": "ObsPing",
            "effect.attempt": 1,
          })
          expect(yield* valueOf("durable-actors.relay.delivered", { kind: "intent" })).toBe(1)
          expect(yield* valueOf("durable-actors.relay.delivered", { kind: "effect" })).toBe(1)
          expect(yield* valueOf("durable-actors.outbox.staged", { kind: "intent" })).toBe(1)
          expect(yield* valueOf("durable-actors.outbox.staged", { kind: "effect" })).toBe(1)
        }),
      ),
  },
  {
    name: "counts turns, receipts, events, and activations, records mailbox age, and exposes them to Prometheus",
    run: ({ expect, environment }) =>
      withTelemetry(environment, () =>
        Effect.gen(function* () {
          yield* (yield* Author.get("a5")).Bump(1)
          yield* (yield* Author.get("a5")).Bump(1)
          yield* (yield* Author.get("a6")).Bump(1)

          const author = { actor_type: "ObsAuthor" }

          expect(yield* valueOf("durable-actors.turns", { ...author, outcome: "success" })).toBe(3)
          expect(yield* valueOf("durable-actors.receipts.written", author)).toBe(3)
          expect(yield* valueOf("durable-actors.events.appended", author)).toBe(3)
          expect(yield* valueOf("durable-actors.activations", author)).toBe(2)
          expect(yield* valueOf("durable-actors.activations.started", author)).toBe(2)
          expect(yield* valueOf("durable-actors.mailbox.age_ms", author)).toBe(3)
          expect(yield* valueOf("durable-actors.turn.duration_ms", author)).toBe(3)

          const text = yield* PrometheusMetrics.format()

          expect(text).toContain("# TYPE durable_actors_turns counter")
          expect(text).toContain('durable_actors_turns{actor_type="ObsAuthor",outcome="success"} 3')
          expect(text).toContain('durable_actors_activations{actor_type="ObsAuthor"} 2')
          expect(text).toContain("durable_actors_mailbox_age_ms_bucket{")
          expect(text).not.toContain("a5")
          expect(text).not.toContain("tenant")
        }),
      ),
  },
  {
    name: "samples outbox rows, the lag of an effect no runner executes, and intents claimed 8 times",
    run: ({ expect, environment }) =>
      withTelemetry(environment, () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const author = yield* Author.get("a7")

          failing.receive = true
          yield* author.Send("stuck")
          yield* (yield* Orphanage.get("o1")).Strand("waits")
          yield* test.advance(0)

          yield* execute(sql, `UPDATE actor_outbox SET attempts = 8 WHERE kind = 'intent'`)
          yield* execute(
            sql,
            `UPDATE actor_outbox SET due_at_ms = due_at_ms - 5000 WHERE command = 'ObsOrphan'`,
          )
          yield* sample

          expect(yield* valueOf(Metrics.outboxRows.id, { kind: "intent" })).toBe(1)
          expect(yield* valueOf(Metrics.outboxRows.id, { kind: "effect" })).toBe(1)
          expect(yield* valueOf(Metrics.stuckRows.id, { kind: "intent" })).toBe(1)
          expect(((yield* valueOf(Metrics.relayLag.id, { kind: "effect" })) ?? -1) >= 5000).toBe(
            true,
          )
          expect(yield* valueOf(Metrics.relayLag.id, { kind: "intent" })).toBe(0)
          expect(yield* valueOf("durable-actors.relay.retried", { kind: "intent" })).toBe(1)

          failing.receive = false
          yield* execute(sql, `UPDATE actor_outbox SET due_at_ms = 0 WHERE kind = 'intent'`)
          yield* test.advance(0)
          yield* sample

          expect(yield* valueOf(Metrics.outboxRows.id, { kind: "intent" })).toBe(0)
          expect(yield* valueOf(Metrics.stuckRows.id, { kind: "intent" })).toBe(0)
        }),
      ),
  },
  {
    name: "samples subscription lag, stuck rows, and pinned events, and counts a gap without a recipient",
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      withTelemetry(environment, () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const author = yield* Author.get("a8")

          yield* author.Bump(1)
          yield* author.Bump(1)
          yield* author.Bump(1)
          yield* test.advance(0)

          yield* sql<{ attempts: number }>`SELECT attempts FROM actor_subscriptions
            WHERE subscription = 'ObsWatch'`.pipe(
            Effect.repeat({ until: (rows) => (rows[0]?.attempts ?? 0) > 0 }),
            Effect.orDie,
          )
          yield* execute(sql, `UPDATE actor_subscriptions SET attempts = 8`)
          yield* sample

          const watch = { subscriber_type: "ObsWatcher", subscription: "ObsWatch" }

          expect(yield* valueOf(Metrics.subscriptionLagEvents.id, watch)).toBe(3)
          expect(((yield* valueOf(Metrics.subscriptionLag.id, watch)) ?? -1) >= 0).toBe(true)
          expect(yield* valueOf(Metrics.stuckRows.id, { kind: "subscription" })).toBe(1)
          expect(yield* valueOf(Metrics.subscriptionPinned.id, { actor_type: "ObsAuthor" })).toBe(0)
          expect(
            ((yield* valueOf("durable-actors.relay.retried", { kind: "subscription" })) ?? 0) >= 1,
          ).toBe(true)

          yield* test.advance("90 minutes")
          yield* sample

          expect(yield* valueOf(Metrics.subscriptionPinned.id, { actor_type: "ObsAuthor" })).toBe(3)
          expect(yield* valueOf(Metrics.workflowPinned.id, { actor_type: "ObsAuthor" })).toBe(0)

          yield* test.advance("1 hour")
          yield* test.cleanup
          yield* execute(
            sql,
            `UPDATE actor_subscriptions SET due_at_ms = 0 WHERE subscription = 'ObsWatch'`,
          )
          yield* test.advance(0)
          yield* sql<{ gaps: string }>`SELECT gaps::text AS gaps FROM actor_subscriptions
            WHERE subscription = 'ObsWatch'`.pipe(
            Effect.repeat({ until: (rows) => rows[0]?.gaps === "1" }),
            Effect.orDie,
          )
          yield* sample

          expect(yield* valueOf(Metrics.undeliverableGaps.id, watch)).toBe(1)
          expect(yield* valueOf("durable-actors.events.pruned", { actor_type: "ObsAuthor" })).toBe(
            3,
          )
          expect(yield* valueOf(Metrics.subscriptionPinned.id, { actor_type: "ObsAuthor" })).toBe(0)
          expect(yield* valueOf(Metrics.subscriptionLagEvents.id, watch)).toBe(0)
        }),
      ),
  },
]
