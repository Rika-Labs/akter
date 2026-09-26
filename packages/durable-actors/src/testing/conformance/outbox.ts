import { Cause, DateTime, Duration, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Caller, Intent, System } from "../../index.ts"
import type { InTurn } from "../../handles/intents.ts"
import { CommandId } from "../../identity/command.ts"
import { claimIntents } from "../../runtime/turn/relay.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase } from "../conformance.ts"

export interface OutboxFixture {
  /** Receiver handler runs, including runs whose turn later rolled back. */
  receives: number
  /** Makes the next `Receive` die once, as a receiver defect would. */
  failNext: boolean
  escaped: Effect.Effect<void, never, InTurn>
}

export const outboxFixture = (): OutboxFixture => ({
  receives: 0,
  failNext: false,
  escaped: Effect.void,
})

const Delivery = Schema.Struct({ body: Schema.String, commandId: Schema.String, caller: Caller })

const InboxLog = Schema.Struct({ log: Schema.optional(Schema.Array(Delivery)) })

const Receive = Actor.command("Receive", { input: Schema.String })

const Touch = Actor.command("Touch")

const Inbox = Actor.make("Inbox", {
  key: Schema.String,
  state: Actor.state({
    log: Schema.Array(Delivery).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  api: { Touch },
  // Only System callers reach Receive, so every delivery proves the relay's caller.
  internal: { Receive },
})

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const Message = Schema.Struct({ to: Schema.String, body: Schema.String })

const Send = Actor.command("Send", { input: Message })

const SendThenRefuse = Actor.command("SendThenRefuse", { input: Message, errors: [Refused] })

const SendThenDie = Actor.command("SendThenDie", { input: Message })

const Schedule = Actor.command("Schedule", {
  input: Schema.Struct({
    ...Message.fields,
    afterMs: Schema.optional(Schema.Int),
    atMs: Schema.optional(Schema.Int),
    key: Schema.optional(Schema.String),
  }),
})

const Cancel = Actor.command("Cancel", { input: Schema.String })

const CancelThenRefuse = Actor.command("CancelThenRefuse", {
  input: Schema.String,
  errors: [Refused],
})

const Escape = Actor.command("Escape", { input: Schema.String })

const Steal = Actor.command("Steal")

const Outboxer = Actor.make("Outboxer", {
  key: Schema.String,
  api: { Send, SendThenRefuse, SendThenDie, Schedule, Cancel, CancelThenRefuse, Escape, Steal },
})

const Post = Actor.command("Post")

const Archive = Actor.command("Archive")

const IdleCheck = Actor.command("IdleCheck")

// The chat room's idle timer from the M1 plan, reduced to its outbox behavior.
const Room = Actor.make("Room", {
  key: Schema.String,
  state: Actor.state({
    closed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  }),
  api: { Post, Archive },
  internal: { IdleCheck },
})

export const outboxLayer = (fixture: OutboxFixture) =>
  Layer.mergeAll(
    Inbox.toLayer(
      Effect.succeed({
        Touch: () => Effect.void,
        Receive: Effect.fnUntraced(function* (body: string) {
          const turn = yield* Inbox.Turn
          fixture.receives += 1

          if (fixture.failNext) {
            fixture.failNext = false

            return yield* Effect.die(new Error("Receiver defect"))
          }

          yield* turn.state.set({
            log: [...turn.state.log, { body, commandId: turn.commandId, caller: turn.caller }],
          })
        }),
      }),
    ),
    Outboxer.toLayer(
      Effect.succeed({
        Send: Effect.fnUntraced(function* ({ to, body }) {
          yield* (yield* Inbox.intents(to)).Receive(body)
        }),
        SendThenRefuse: Effect.fnUntraced(function* ({ to, body }) {
          yield* (yield* Inbox.intents(to)).Receive(body)

          return yield* Refused.make({})
        }),
        SendThenDie: Effect.fnUntraced(function* ({ to, body }) {
          yield* (yield* Inbox.intents(to)).Receive(body)

          return yield* Effect.die(new Error("Sender defect after staging"))
        }),
        Schedule: Effect.fnUntraced(function* ({ to, body, afterMs, atMs, key }) {
          let intent = (yield* Inbox.intents(to)).Receive(body)

          if (afterMs !== undefined) intent = intent.pipe(Intent.after(Duration.millis(afterMs)))

          if (atMs !== undefined) intent = intent.pipe(Intent.at(DateTime.makeUnsafe(atMs)))

          if (key !== undefined) intent = intent.pipe(Intent.key(key))
          yield* intent
        }),
        Cancel: (key: string) => Intent.cancel(key),
        CancelThenRefuse: Effect.fnUntraced(function* (key: string) {
          yield* Intent.cancel(key)

          return yield* Refused.make({})
        }),
        Escape: Effect.fnUntraced(function* (to: string) {
          fixture.escaped = (yield* Inbox.intents(to)).Receive("escaped")
        }),
        Steal: () => Effect.suspend(() => fixture.escaped),
      }),
    ),
    Room.toLayer(
      Effect.succeed({
        Post: Effect.fnUntraced(function* () {
          const turn = yield* Room.Turn
          const self = yield* Room.intents(turn.id)
          yield* self.IdleCheck().pipe(Intent.after("24 hours"), Intent.key("idle"))
        }),
        Archive: Effect.fnUntraced(function* () {
          const turn = yield* Room.Turn
          yield* turn.state.set({ closed: true })
          yield* Intent.cancel("idle")
        }),
        IdleCheck: Effect.fnUntraced(function* () {
          const self = yield* Room.intents((yield* Room.Turn).id)
          yield* self.Archive()
        }),
      }),
    ),
  )

const inboxLog = Effect.fnUntraced(function* (to: string) {
  const inbox = yield* Inbox.get(to)
  const { state } = yield* (yield* ActorTest).inspect(inbox.ref)

  return (yield* Schema.decodeUnknownEffect(InboxLog)(state).pipe(Effect.orDie)).log ?? []
})

const receivedBodies = (to: string) =>
  inboxLog(to).pipe(Effect.map((log) => log.map(({ body }) => body)))

interface PlanNode {
  readonly "Node Type": string
  readonly "Relation Name"?: string | undefined
  readonly "Index Name"?: string | undefined
  readonly "Actual Rows": number
  readonly "Shared Hit Blocks": number
  readonly "Shared Read Blocks": number
  readonly Plans?: ReadonlyArray<PlanNode> | undefined
}

const PlanNode: Schema.Codec<PlanNode> = Schema.Struct({
  "Node Type": Schema.String,
  "Relation Name": Schema.optional(Schema.String),
  "Index Name": Schema.optional(Schema.String),
  "Actual Rows": Schema.Finite,
  "Shared Hit Blocks": Schema.Finite,
  "Shared Read Blocks": Schema.Finite,
  Plans: Schema.optional(Schema.Array(Schema.suspend(() => PlanNode))),
})

const ExplainOutput = Schema.Tuple([Schema.Struct({ Plan: PlanNode })])

const explainScan = Effect.fnUntraced(function* (now: number) {
  const sql = yield* SqlClient.SqlClient
  const [text, parameters] = claimIntents({
    sql,
    now,
    limit: 16,
    leaseMs: 37_000,
    maxBackoffMs: 256_000,
  }).compile()

  const [row] = yield* sql.unsafe<{ readonly "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`,
    parameters,
  )

  const [output] = yield* Schema.decodeUnknownEffect(ExplainOutput)(row?.["QUERY PLAN"]).pipe(
    Effect.orDie,
  )

  return output.Plan
})

const planNodes = (node: PlanNode): ReadonlyArray<PlanNode> => [
  node,
  ...(node.Plans ?? []).flatMap(planNodes),
]

// Sleeping actors spread over every bucket, each with a timer due in a day.
const seedSleepers = Effect.fnUntraced(function* (from: number, to: number, dueAt: number) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
    SELECT ((i % 256) - 128)::bigint << 56 | i, 'scan', 'Sleeper', i::text
    FROM generate_series(${from}::int, ${to}::int) AS i`
  yield* sql`INSERT INTO actor_outbox (routing_key, intent_id, bucket, due_at_ms, tenant_id,
      actor_type, actor_id, target_type, target_id, command, payload, caller)
    SELECT ((i % 256) - 128)::bigint << 56 | i, 'sleep-' || i, (i % 256) - 128, ${dueAt}::bigint,
      'scan', 'Sleeper', i::text, 'Sleeper', i::text, 'Wake', '{}', '{}'
    FROM generate_series(${from}::int, ${to}::int) AS i`
  yield* sql`ANALYZE actor_outbox`
})

const measureScan = Effect.fnUntraced(function* (now: number) {
  const root = yield* explainScan(now)

  const outbox = planNodes(root).filter(
    (node) =>
      node["Relation Name"] === "actor_outbox" || node["Index Name"]?.startsWith("actor_outbox"),
  )

  return {
    seqScans: outbox.filter((node) => node["Node Type"] === "Seq Scan").length,
    indexes: [...new Set(outbox.flatMap((node) => node["Index Name"] ?? []))],
    rows: root["Actual Rows"],
    // Index entries the due index returned: sleeping timers must never be among them.
    indexRows: outbox
      .filter((node) => node["Index Name"] === "actor_outbox_due_kind")
      .reduce((total, node) => total + node["Actual Rows"], 0),
    // A plan node's buffer counts include its children, so the root is the query total.
    blocks: root["Shared Hit Blocks"] + root["Shared Read Blocks"],
  }
})

/** The default claim lease for these actors: 30 s `commandTimeout` + 2 s `lockWait` + 5 s. */
export const CLAIM_LEASE = "37 seconds"

export const outboxConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "delivers a committed intent as a System command whose command id is the intent id",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sender = yield* Outboxer.get("deliver")
          yield* sender.Send({ to: "deliver-inbox", body: "hello" })
          yield* test.advance(0)
          const inbox = yield* Inbox.get("deliver-inbox")
          const [delivery] = yield* inboxLog("deliver-inbox")

          expect(delivery?.body).toBe("hello")
          expect(Schema.is(CommandId)(delivery?.commandId)).toBe(true)
          expect(delivery?.caller).toEqual(
            System.make({ source: "actor", ref: sender.ref, onBehalfOf: { subject: "alice" } }),
          )
          expect(yield* test.receiptsFor(inbox.ref, "Receive")).toBe(1)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ receipts: 1, outbox: 0 })
        }),
      ),
  },
  {
    name: "never delivers intents from a declared failure or a rolled-back turn",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sender = yield* Outboxer.get("rollback")
          const before = fixture.outbox.receives
          expect(
            yield* sender
              .SendThenRefuse({ to: "rollback-inbox", body: "refused" })
              .pipe(Effect.flip),
          ).toBeInstanceOf(Refused)

          const died = yield* sender
            .SendThenDie({ to: "rollback-inbox", body: "died" })
            .pipe(Effect.exit)

          expect(Exit.isFailure(died) && Cause.pretty(died.cause)).toContain("Sender defect")
          yield* test.crashNext("beforeCommit")
          yield* sender.Send({ to: "rollback-inbox", body: "retried" })
          yield* test.advance(0)
          expect(yield* receivedBodies("rollback-inbox")).toEqual(["retried"])
          expect(fixture.outbox.receives - before).toBe(1)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ receipts: 2, outbox: 0 })
        }),
      ),
  },
  {
    name: "keeps a staged intent invisible and undelivered until its turn commits",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sender = yield* Outboxer.get("visibility")
          const pause = yield* test.pauseNext("beforeCommit")

          const waiter = yield* sender
            .Send({ to: "visibility-inbox", body: "later" })
            .pipe(Effect.forkChild)

          yield* pause.reached
          yield* test.advance(0)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ receipts: 0, outbox: 0 })
          expect(yield* receivedBodies("visibility-inbox")).toEqual([])
          yield* pause.release
          yield* Fiber.join(waiter)
          yield* test.advance(0)
          expect(yield* receivedBodies("visibility-inbox")).toEqual(["later"])
        }),
      ),
  },
  {
    name: "delays timers until due, past the retry window and after caller revocation",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sender = yield* Outboxer.get("timers")
          const now = DateTime.toEpochMillis(yield* test.now)
          yield* sender.Schedule({ to: "timers-inbox", body: "after", afterMs: 3_600_000 })
          yield* sender.Schedule({ to: "timers-inbox", body: "at", atMs: now + 7_200_000 })
          yield* test.advance(0)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 2 })
          yield* test.advance("59 minutes")
          expect(yield* receivedBodies("timers-inbox")).toEqual([])
          // A committed obligation outlives its caller's access and the external retry window.
          fixture.allowed = false
          yield* test
            .advance("1 minute")
            .pipe(Effect.ensuring(Effect.sync(() => (fixture.allowed = true))))
          expect(yield* receivedBodies("timers-inbox")).toEqual(["after"])
          yield* test.advance("1 hour")
          expect(yield* receivedBodies("timers-inbox")).toEqual(["after", "at"])
          expect((yield* inboxLog("timers-inbox")).map(({ caller }) => caller)).toMatchObject([
            { source: "timer" },
            { source: "timer" },
          ])
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 0 })
        }),
      ),
  },
  {
    name: "replaces a pending keyed timer and cancels it in the same transaction",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sender = yield* Outboxer.get("keyed")
          const to = "keyed-inbox"
          yield* sender.Schedule({ to, body: "first", afterMs: 3_600_000, key: "k" })
          yield* sender.Schedule({ to, body: "second", afterMs: 7_200_000, key: "k" })
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 1 })
          yield* test.advance("1 hour")
          expect(yield* receivedBodies(to)).toEqual([])
          yield* test.advance("1 hour")
          expect(yield* receivedBodies(to)).toEqual(["second"])

          yield* sender.Schedule({ to, body: "cancelled", afterMs: 60_000, key: "k" })
          expect(yield* sender.CancelThenRefuse("k").pipe(Effect.flip)).toBeInstanceOf(Refused)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 1 })
          yield* sender.Cancel("k")
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 0 })
          yield* test.advance("1 hour")
          expect(yield* receivedBodies(to)).toEqual(["second"])
        }),
      ),
  },
  {
    name: "pushes back the idle timer and archives once across crashes after the receiver commits",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const room = yield* Room.get("r2")
          yield* room.Post()
          yield* test.advance("23 hours")
          yield* room.Post()
          yield* test.advance("23 hours")
          expect(yield* test.inspect(room.ref)).toMatchObject({ receipts: 2, outbox: 1 })
          expect((yield* test.inspect(room.ref)).state).toEqual({})
          // The timer's receiver turn crashes after committing, then the relay dies before deleting its row.
          yield* test.crashNext("afterCommit")
          yield* test.crashNext("beforeOutboxDelete")
          yield* test.advance("1 hour")
          expect(yield* test.inspect(room.ref)).toMatchObject({
            state: { closed: true },
            outbox: 0,
          })
          expect(yield* test.receiptsFor(room.ref, "IdleCheck")).toBe(1)
          expect(yield* test.receiptsFor(room.ref, "Archive")).toBe(1)
        }),
      ),
  },
  {
    name: "redelivers after a relay crash before outbox row deletion with one receiver transition",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sender = yield* Outboxer.get("relay-crash")
          const inbox = yield* Inbox.get("relay-crash-inbox")
          const before = fixture.outbox.receives
          yield* sender.Schedule({ to: "relay-crash-inbox", body: "once", afterMs: 60_000 })

          // The first delivery crashes before deleting the row, whose claim then holds it
          // until the lease ends; the redelivery after that pauses there.
          yield* test.crashNext("beforeOutboxDelete")
          const pause = yield* test.pauseNext("beforeOutboxDelete")
          yield* test.advance("1 minute")
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 1 })
          const draining = yield* test.advance(CLAIM_LEASE).pipe(Effect.forkChild)
          yield* pause.reached
          // The receiver committed once; the crashed pass left the sender's row pending.
          expect(fixture.outbox.receives - before).toBe(1)
          expect(yield* test.receiptsFor(inbox.ref, "Receive")).toBe(1)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 1 })
          yield* pause.release
          yield* Fiber.join(draining)

          expect(yield* receivedBodies("relay-crash-inbox")).toEqual(["once"])
          expect(fixture.outbox.receives - before).toBe(1)
          expect(yield* test.receiptsFor(inbox.ref, "Receive")).toBe(1)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 0 })
        }),
      ),
  },
  {
    name: "rolls back a relay-delivered turn that crashes before commit and delivers it once",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sender = yield* Outboxer.get("receiver-crash")
          const inbox = yield* Inbox.get("receiver-crash-inbox")
          const before = fixture.outbox.receives
          yield* sender.Schedule({ to: "receiver-crash-inbox", body: "once", afterMs: 60_000 })
          yield* test.crashNext("beforeCommit")
          yield* test.advance("1 minute")
          // The crashed attempt ran the handler and rolled back; the retry committed once.
          expect(fixture.outbox.receives - before).toBe(2)
          expect(yield* receivedBodies("receiver-crash-inbox")).toEqual(["once"])
          expect(yield* test.receiptsFor(inbox.ref, "Receive")).toBe(1)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 0 })
        }),
      ),
  },
  {
    name: "delivers a keyed timer once when it is cancelled after the relay picked it up",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sender = yield* Outboxer.get("in-flight")
          const to = "in-flight-inbox"
          yield* sender.Schedule({ to, body: "firing", afterMs: 60_000, key: "k" })
          const pause = yield* test.pauseNext("beforeDelivery")
          const draining = yield* test.advance("1 minute").pipe(Effect.forkChild)
          yield* pause.reached
          // The timer is firing, so it is no longer pending: the cancel finds nothing.
          yield* sender.Cancel("k")
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 0 })
          yield* pause.release
          yield* Fiber.join(draining)
          expect(yield* receivedBodies(to)).toEqual(["firing"])
          yield* test.advance("1 hour")
          expect(yield* receivedBodies(to)).toEqual(["firing"])
        }),
      ),
  },
  {
    name: "keeps an intent whose receiver defects and retries it with backoff",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sender = yield* Outboxer.get("backoff")
          const inbox = yield* Inbox.get("backoff-inbox")
          yield* sender.Schedule({ to: "backoff-inbox", body: "retried", afterMs: 60_000 })
          fixture.outbox.failNext = true
          yield* test.advance("1 minute")
          expect(yield* test.receiptsFor(inbox.ref, "Receive")).toBe(0)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 1 })
          const sql = yield* SqlClient.SqlClient
          expect(
            yield* sql`SELECT attempts FROM actor_outbox WHERE tenant_id = ${sender.ref.tenant}
              AND actor_type = 'Outboxer' AND actor_id = 'backoff'`,
          ).toEqual([{ attempts: 1 }])
          yield* test.advance("1 second")
          expect(yield* receivedBodies("backoff-inbox")).toEqual(["retried"])
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 0 })
        }),
      ),
  },
  {
    name: "rejects escaped intent capabilities without writing an outbox row",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sender = yield* Outboxer.get("escape")
          yield* sender.Escape("escape-inbox")
          const stolen = yield* sender.Steal().pipe(Effect.exit)
          expect(Exit.isFailure(stolen) && Cause.pretty(stolen.cause)).toContain(
            "Intent capability escaped its turn",
          )

          const outside = yield* Intent.cancel("k").pipe(
            Effect.provideService(Actor.InTurn, Actor.InTurn.of({ turn: Symbol() })),
            Effect.exit,
          )

          expect(Exit.isFailure(outside) && Cause.pretty(outside.cause)).toContain(
            "Intent capability escaped its turn",
          )
          yield* test.advance(0)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ receipts: 1, outbox: 0 })
          expect(yield* receivedBodies("escape-inbox")).toEqual([])
        }),
      ),
  },
  {
    name: "scans due work by bucket without reading sleeping actors' future timers",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          yield* test.advance(0)
          const now = DateTime.toEpochMillis(yield* test.now)
          const tomorrow = now + 86_400_000

          yield* Effect.gen(function* () {
            yield* seedSleepers(1, 5_000, tomorrow)
            const small = yield* measureScan(now)
            yield* seedSleepers(5_001, 50_000, tomorrow)
            const large = yield* measureScan(now)

            for (const scan of [small, large]) {
              expect(scan).toMatchObject({ seqScans: 0, rows: 0, indexRows: 0 })
              // The primary key only locates claimed rows, and there are none.
              expect(scan.indexes.filter((index) => index !== "actor_outbox_pkey")).toEqual([
                "actor_outbox_due_kind",
              ])
            }
            // The planner may skip the per-bucket probe when no intent is due at all, so the
            // bound is absolute: at most three index levels for each of the 256 bucket probes.
            expect(large.blocks <= 3 * 256).toBe(true)
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* sql`DELETE FROM actor_outbox WHERE tenant_id = 'scan'`
                yield* sql`DELETE FROM actor_generations WHERE tenant_id = 'scan'`
              }).pipe(Effect.orDie),
            ),
          )
        }),
      ),
  },
]
