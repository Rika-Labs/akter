import {
  Cause,
  Context,
  Crypto,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Schema,
  type Scope,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, type Actors, type Caller, Intent, User } from "../../index.ts"
import { Seed } from "../../runtime/operators/seed.ts"
import type { Capability } from "../../runtime/operators/grants.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"
import { type Harness, operatorHarness } from "./operator-harness.ts"

const LedgerV0 = { total: Schema.Int }

const LedgerV1 = {
  balance: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  memo: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
}

const Announce = Actor.job("ExpAnnounce", {
  payload: { text: Schema.String },
})

const Deposit = Actor.command("Deposit", { payload: Schema.Int })

const Audit = Actor.command("Audit")

const Ledger = Actor.make("ExpLedger", {
  key: Schema.String,
  jobs: { ExpAnnounce: { job: Announce } },
  state: Actor.state(LedgerV1, {
    migrations: [
      Actor.migration(LedgerV0, LedgerV1, ({ total }) => ({ balance: total, memo: "" })),
    ],
  }),
  api: { Deposit },
  internal: { Audit },
})

/** What the ledger's timer and executor observed, and reset before each case. */
const fixture = {
  audits: [] as Array<Caller>,
  announced: [] as Array<string>,
}

const live = Layer.mergeAll(
  Ledger.toLayer(
    Effect.succeed({
      Deposit: Effect.fnUntraced(function* (amount: number) {
        const turn = yield* Ledger.Turn

        yield* turn.state.set({
          balance: turn.state.balance + amount,
          memo: `deposited ${amount}`,
        })

        yield* (yield* Ledger.intents(turn.id))
          .Audit()
          .pipe(Intent.after("1 minute"), Intent.key("audit"))

        yield* turn.enqueue(Announce.make({ text: `deposited ${amount}` }), {
          key: "announce",
          after: Duration.hours(1),
        })
      }),
      Audit: Effect.fnUntraced(function* () {
        fixture.audits.push((yield* Ledger.Turn).caller)
      }),
    }),
  ),
  Ledger.toJobLayer(
    Effect.succeed({
      ExpAnnounce: ({ text }) =>
        Effect.sync(() => {
          fixture.announced.push(text)
        }),
    }),
  ),
)

const withOperators = <A, E>(
  environment: ConformanceEnvironment,
  tokens: Record<string, ReadonlyArray<Capability>>,
  body: (
    harness: Harness,
  ) => Effect.Effect<A, E, Actors | ActorTest | SqlClient.SqlClient | Crypto.Crypto | Scope.Scope>,
) =>
  operatorHarness({
    environment,
    live,
    reset: () => {
      Object.assign(fixture, { audits: [], announced: [] })
    },
    tokens,
    body,
  })

/** A second runtime on its own database, and so its own tenant, running as `as`. */
const replayRuntime = (environment: ConformanceEnvironment, as: Caller) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const database = yield* environment.freshDatabase

    return yield* Layer.buildWithMemoMap(
      live.pipe(
        Layer.provideMerge(
          ActorTest.layer({
            database,
            as,
            authorize: () => Effect.succeed(true),
            retryWindowMs: 60_000,
          }),
        ),
        Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
        Layer.orDie,
      ),
      yield* Layer.makeMemoMap,
      yield* Effect.scope,
    )
  })

/** A file system holding these seed files, each given as the value its JSON is written from. */
const seedFiles = Effect.fnUntraced(function* (
  files: ReadonlyArray<readonly [path: string, contents: unknown]>,
) {
  const texts = new Map<string, string>()

  for (const [path, value] of files) texts.set(path, yield* encodeJson(value).pipe(Effect.orDie))

  return FileSystem.makeNoop({ readFileString: (path) => Effect.succeed(texts.get(path) ?? "") })
})

const paths = (tenant: string, id = "l1") => ({
  inspect: `/operator/actors/ExpLedger/${id}?tenant=${tenant}`,
  export: `/operator/actors/ExpLedger/${id}/export?tenant=${tenant}`,
})

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const exporter = {
  "export-token": [{ action: "export", tenant: "*", actorType: "ExpLedger" }],
} satisfies Record<string, ReadonlyArray<Capability>>

/** Deposits into `l1` from an old-shape state, so it holds state at version 1, a timer, and an effect. */
const fundedLedger = Effect.gen(function* () {
  const test = yield* ActorTest
  const ledger = yield* Ledger.get("l1")
  yield* test.seed(ledger.ref, { total: 2 }, 0)
  yield* ledger.Deposit(3)

  return ledger
})

/** Every row count and content digest of the runtime's tables, so a read that wrote would show. */
const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const [snapshot] = yield* sql<Record<string, string>>`SELECT
    (SELECT count(*) || ':' || max(generation) || ':' || max(event_sequence) FROM actor_generations) AS generations,
    (SELECT count(*) || ':' || coalesce(md5(string_agg(key || encode(value, 'hex'), ',' ORDER BY key)), '') FROM actor_state) AS state,
    (SELECT count(*) || ':' || coalesce(md5(string_agg(intent_id || attempts::text, ',' ORDER BY intent_id)), '') FROM actor_outbox) AS outbox,
    (SELECT count(*) FROM actor_receipts)::text AS receipts,
    (SELECT count(*) FROM actor_events)::text AS events,
    (SELECT count(*) FROM actor_dead_letters)::text AS dead_letters`

  return snapshot!
}).pipe(Effect.orDie)

const literalSeed = {
  format: 1,
  actor: { type: "ExpLedger", id: "l1" },
  created: false,
  stateVersion: 1,
  state: { balance: 5, memo: "literal" },
  intents: [],
  effects: [],
  omitted: { receipts: 0, events: 0, workflows: 0, deadLetters: 0, tableRows: 0, blobs: 0 },
}

const died = (exit: Exit.Exit<unknown, unknown>, message: string) =>
  Exit.isFailure(exit) && Cause.hasDies(exit.cause) && Cause.pretty(exit.cause).includes(message)

export const exportConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "exports an actor's state and pending work as a seed with no tenant or caller, and audits the read",
    run: ({ expect, environment }) =>
      withOperators(environment, exporter, ({ tenant, send, audit }) =>
        Effect.gen(function* () {
          yield* fundedLedger

          const answer = yield* send("GET", paths(tenant).export, "export-token")
          const seed = yield* Schema.decodeUnknownEffect(Seed)(answer.body).pipe(Effect.orDie)

          expect(answer.status).toBe(200)
          expect(seed).toMatchObject({
            format: 1,
            actor: { type: "ExpLedger", id: "l1" },
            created: false,
            stateVersion: 1,
            state: { balance: 5, memo: "deposited 3" },
            intents: [{ target: { actor: "ExpLedger", id: "l1" }, command: "Audit", key: "audit" }],
            effects: [
              {
                effect: "ExpAnnounce",
                payload: { text: "deposited 3" },
                payloadVersion: 0,
                key: "announce",
              },
            ],
            omitted: {
              receipts: 1,
              events: 0,
              workflows: 0,
              deadLetters: 0,
              tableRows: 0,
              blobs: 0,
            },
          })

          const [intent] = seed.intents
          const [effect] = seed.effects

          expect(intent!.dueInMs > 30_000 && intent!.dueInMs <= 60_000).toBe(true)
          expect(effect!.dueInMs > 3_500_000 && effect!.dueInMs <= 3_600_000).toBe(true)

          const text = yield* encodeJson(answer.body).pipe(Effect.orDie)

          expect(text.includes(tenant)).toBe(false)
          expect(text.includes("alice")).toBe(false)
          expect(yield* audit).toMatchObject([
            {
              operator: "op-export-token",
              action: "export",
              actor_id: "l1",
              capability: '{"action":"export","tenant":"*","actorType":"ExpLedger"}',
              outcome: '"read"',
            },
          ])
        }),
      ),
  },
  {
    name: "reads the actor without writing any table",
    run: ({ expect, environment }) =>
      withOperators(environment, exporter, ({ tenant, send }) =>
        Effect.gen(function* () {
          yield* fundedLedger
          const before = yield* rows

          for (let index = 0; index < 2; index++)
            expect((yield* send("GET", paths(tenant).export, "export-token")).status).toBe(200)

          expect(yield* rows).toEqual(before)
        }),
      ),
  },
  {
    name: "refuses an export outside the export grant, audits the denial, and returns no state",
    run: ({ expect, environment }) =>
      withOperators(
        environment,
        {
          "look-token": [
            { action: "inspect", tenant: "*" },
            { action: "receipts.read", tenant: "*" },
          ],
          "narrow-token": [
            { action: "export", tenant: "*", actorType: "ExpLedger", actorId: "l2" },
            { action: "export", tenant: "another-tenant", actorType: "ExpLedger" },
            { action: "export", tenant: "*", actorType: "ExpOther" },
          ],
        },
        ({ tenant, send, audit }) =>
          Effect.gen(function* () {
            yield* fundedLedger

            for (const token of ["look-token", "narrow-token"]) {
              const answer = yield* send("GET", paths(tenant).export, token)

              expect(answer.status).toBe(403)
              expect((yield* encodeJson(answer.body).pipe(Effect.orDie)).includes('"state"')).toBe(
                false,
              )
            }

            for (const token of ["app-token", undefined])
              expect((yield* send("GET", paths(tenant).export, token)).status).toBe(401)

            expect(
              (yield* audit).map(({ operator, action, capability, outcome }) => [
                operator,
                action,
                capability,
                outcome,
              ]),
            ).toEqual([
              ["op-look-token", "export", null, '"denied"'],
              ["op-narrow-token", "export", null, '"denied"'],
            ])
          }),
      ),
  },
  {
    name: "answers no seed when the audit row cannot be written",
    run: ({ expect, environment }) =>
      withOperators(environment, exporter, ({ tenant, send, audit }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* fundedLedger

          yield* sql`CREATE FUNCTION exp_audit_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN RAISE EXCEPTION 'audit unavailable'; END $$`.pipe(Effect.orDie)
          yield* sql`CREATE TRIGGER exp_audit_refuse BEFORE INSERT ON actor_operator_audit
              FOR EACH ROW EXECUTE FUNCTION exp_audit_refuse()`.pipe(Effect.orDie)

          const failed = yield* send("GET", paths(tenant).export, "export-token")

          expect(failed.status).toBe(500)
          expect((yield* encodeJson(failed.body).pipe(Effect.orDie)).includes("balance")).toBe(
            false,
          )
          expect(yield* audit).toEqual([])
        }),
      ),
  },
  {
    name: "answers not found for an actor of another tenant, however broad the grant",
    run: ({ expect, environment }) =>
      withOperators(environment, exporter, ({ send }) =>
        Effect.gen(function* () {
          yield* fundedLedger

          expect((yield* send("GET", paths("another-tenant").export, "export-token")).status).toBe(
            404,
          )
          expect(
            (yield* send("GET", paths("another-tenant", "l9").export, "export-token")).status,
          ).toBe(404)
        }),
      ),
  },
  {
    name: "refuses an actor whose stored state does not decode, naming the key and never its value",
    run: ({ expect, environment }) =>
      withOperators(environment, exporter, ({ tenant, send, audit }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* fundedLedger

          yield* sql`UPDATE actor_state SET value = ${new TextEncoder().encode("secret-not-zstd")} WHERE key = 'balance'`

          const answer = yield* send("GET", paths(tenant).export, "export-token")

          expect(answer.status).toBe(409)
          expect(answer.body).toMatchObject({ reason: "undecodable", detail: "state balance" })
          expect((yield* encodeJson(answer.body).pipe(Effect.orDie)).includes("secret")).toBe(false)
          expect((yield* audit).map(({ action }) => action)).toEqual(["export"])
        }),
      ),
  },
  {
    name: "refuses an actor holding more pending work than one export carries",
    run: ({ expect, environment }) =>
      withOperators(environment, exporter, ({ tenant, send }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* fundedLedger

          yield* sql`INSERT INTO actor_outbox (routing_key, intent_id, kind, bucket, due_at_ms,
              scheduled_at_ms, tenant_id, actor_type, actor_id, target_type, target_id, command, payload, caller)
            SELECT g.routing_key, 'bulk-' || n, 'intent', (g.routing_key >> 56)::int, 4102444800000,
              4102444800000, g.tenant_id, g.actor_type, g.actor_id, g.actor_type, g.actor_id, 'Audit', 'null', '{}'
            FROM actor_generations g, generate_series(1, 10001) n WHERE g.actor_id = 'l1'`

          const answer = yield* send("GET", paths(tenant).export, "export-token")

          expect(answer.status).toBe(409)
          expect(answer.body).toMatchObject({ reason: "too_large", detail: "pending intents" })
        }),
      ),
  },
  {
    name: "starts an actor in another tenant from an exported seed, running its pending work as the test's caller",
    run: ({ expect, environment }) =>
      withOperators(environment, exporter, ({ tenant, send }) =>
        Effect.gen(function* () {
          yield* fundedLedger

          const exported = yield* send("GET", paths(tenant).export, "export-token")
          const files = yield* seedFiles([["l1.seed", exported.body]])
          const replay = yield* replayRuntime(environment, User.make({ subject: "bob" }))

          yield* Effect.gen(function* () {
            const test = yield* ActorTest
            const seeded = yield* test.actor(Ledger, "l1", { seed: "l1.seed" })

            expect(Context.get(replay, ActorTest).tenant === tenant).toBe(false)
            expect(yield* seeded.inspect).toEqual({
              generation: "0",
              state: { balance: 5, memo: "deposited 3" },
              receipts: 0,
              events: 0,
              outbox: 1,
              jobs: 1,
            })

            yield* test.advance(Duration.minutes(2))

            expect(fixture.audits.length).toBe(1)

            const delivered = yield* encodeJson(fixture.audits[0]).pipe(Effect.orDie)

            expect(delivered.includes("bob")).toBe(true)
            expect(delivered.includes("alice")).toBe(false)
            expect(fixture.announced).toEqual([])

            yield* test.advance(Duration.hours(1))

            expect(fixture.announced).toEqual(["deposited 3"])

            const ledger = yield* Ledger.get("l1")
            yield* ledger.Deposit(1)

            expect((yield* test.inspect(ledger.ref)).state).toEqual({
              balance: 6,
              memo: "deposited 1",
            })
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, files),
            Effect.provideContext(replay),
          )
        }),
      ),
  },
  {
    name: "refuses a seed that is malformed, of another actor type, names an unregistered effect, marks created an actor without createdBy, or targets an existing actor, writing nothing",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const replay = yield* replayRuntime(environment, User.make({ subject: "bob" }))

          const files = yield* seedFiles([
            ["wrong-format.seed", { ...literalSeed, format: 2 }],
            ["wrong-type.seed", { ...literalSeed, actor: { type: "ExpOther", id: "l1" } }],
            [
              "unregistered.seed",
              {
                ...literalSeed,
                effects: [{ effect: "ExpMissing", payload: null, payloadVersion: 0, dueInMs: 0 }],
              },
            ],
            ["created.seed", { ...literalSeed, created: true }],
            ["literal.seed", literalSeed],
            ["changed.seed", { ...literalSeed, state: { balance: 99, memo: "new" } }],
          ])

          yield* Effect.gen(function* () {
            const test = yield* ActorTest

            const attempt = (id: string, seed: string) =>
              Effect.exit(test.actor(Ledger, id, { seed }))

            const inspectOf = (id: string) =>
              Ledger.get(id).pipe(Effect.flatMap((ledger) => test.inspect(ledger.ref)))

            expect(died(yield* attempt("m1", "wrong-format.seed"), "Expected")).toBe(true)
            expect(died(yield* attempt("m2", "wrong-type.seed"), "not ExpLedger")).toBe(true)
            expect(died(yield* attempt("m3", "unregistered.seed"), "does not register")).toBe(true)

            expect(died(yield* attempt("m4", "created.seed"), "createdBy")).toBe(true)

            for (const id of ["m1", "m2", "m3", "m4"])
              expect((yield* inspectOf(id)).generation).toBe(undefined)

            expect(Exit.isSuccess(yield* attempt("l1", "literal.seed"))).toBe(true)
            expect(died(yield* attempt("l1", "changed.seed"), "already exists")).toBe(true)
            expect((yield* inspectOf("l1")).state).toEqual({ balance: 5, memo: "literal" })
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, files),
            Effect.provideContext(replay),
          )
        }),
      ),
  },
  {
    name: "seeds nothing when one row of the seed cannot be written",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const replay = yield* replayRuntime(environment, User.make({ subject: "bob" }))

          const intent = {
            target: { actor: "ExpLedger", id: "l1" },
            command: "Audit",
            payload: null,
            key: "audit",
            dueInMs: 0,
          }

          const files = yield* seedFiles([
            ["clash.seed", { ...literalSeed, intents: [intent, intent] }],
          ])

          yield* Effect.gen(function* () {
            const test = yield* ActorTest
            const exit = yield* Effect.exit(test.actor(Ledger, "l1", { seed: "clash.seed" }))
            const ledger = yield* Ledger.get("l1")
            const sql = yield* SqlClient.SqlClient

            expect(Exit.isFailure(exit)).toBe(true)
            expect(yield* test.inspect(ledger.ref)).toEqual({
              generation: undefined,
              state: {},
              receipts: 0,
              events: 0,
              outbox: 0,
              jobs: 0,
            })
            expect(
              (yield* sql<{ count: number }>`SELECT count(*)::int AS count FROM actor_state`)[0]!
                .count,
            ).toBe(0)
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, files),
            Effect.provideContext(replay),
          )
        }),
      ),
  },
]
