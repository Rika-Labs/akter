import { Crypto, Data, Effect, Exit, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Actor, Intent } from "../../index.ts"
import { routingKey } from "../../runtime/storage/codec.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase, ConformanceSuite } from "../conformance.ts"

const Noted = Actor.event("Noted", { body: Schema.String })

class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {}) {}

class Undeliverable extends Schema.TaggedError<Undeliverable>()("Undeliverable", {}) {}

const Deliver = Actor.job("Deliver", {
  payload: { body: Schema.String },
})

const Write = Actor.command("Record", { payload: Schema.String })

const RecordThenReject = Actor.command("RecordThenReject", {
  payload: Schema.String,
  error: Rejected,
})

const RecordThenDie = Actor.command("RecordThenDie", { payload: Schema.String })

const Remind = Actor.command("Remind")

const Specimen = Actor.make("Specimen", {
  key: Schema.String,
  state: Actor.state({
    notes: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  events: [Noted],
  jobs: { Deliver: { job: Deliver, retry: { times: 0 } } },
  api: { Record: Write, RecordThenReject, RecordThenDie },
  internal: { Remind },
})

const record = Effect.fnUntraced(function* (body: string) {
  const turn = yield* Specimen.Turn
  yield* turn.state.set({ notes: [...turn.state.notes, body] })
  yield* turn.emit(Noted.make({ body }))
  const self = yield* Specimen.intents(turn.id)
  yield* self.Remind().pipe(Intent.after("1 hour"), Intent.key("remind"))
  yield* turn.enqueue(Deliver.make({ body }))
})

/** Handlers for the actors whose rows the inspection views expose. */
export const inspectionViewsLayer = Layer.mergeAll(
  Specimen.toLayer(
    Effect.succeed({
      Record: record,
      RecordThenReject: Effect.fnUntraced(function* (body: string) {
        yield* record(body)

        return yield* Rejected.make({})
      }),
      RecordThenDie: Effect.fnUntraced(function* (body: string) {
        yield* record(body)

        return yield* Effect.die(new Error("Specimen defect after writing"))
      }),
      Remind: () => Effect.void,
    }),
  ),
  Specimen.toJobLayer(
    Effect.succeed({
      Deliver: Effect.fnUntraced(function* () {
        return yield* Undeliverable.make({})
      }),
    }),
  ),
)

/**
 * The first set of views joins the actor type's placement into every row; the single-table set
 * ends in `_v2`, leaves placement to `placements_v2`, and splits `contents` in two.
 */
type ViewSet = {
  readonly key: string
  readonly label: string
  readonly name: (view: string) => string
  readonly views: ReadonlyArray<string>
  readonly versions: Readonly<Record<string, number>>
}

const FIRST_SET: ViewSet = {
  key: "first",
  label: "inspection views",
  name: (view) => `durable.${view}`,
  views: [
    "actors",
    "state",
    "receipts",
    "events",
    "outbox",
    "timers",
    "jobs",
    "dead_letters",
    "workflows",
    "workflow_steps",
    "operator_audit",
    "contents",
    "content_refs",
  ],
  versions: { dead_letters: 2, receipts: 2 },
}

const SINGLE_TABLE_SET: ViewSet = {
  key: "single",
  label: "single-table inspection views",
  name: (view) => `durable.${view}_v2`,
  views: [
    "actors",
    "state",
    "receipts",
    "events",
    "outbox",
    "timers",
    "jobs",
    "dead_letters",
    "workflows",
    "workflow_steps",
    "operator_audit",
    "contents",
    "content_sweeps",
    "content_refs",
    "placements",
  ],
  versions: {},
}

type Row = Record<string, string | number | boolean | null>

const rowsOf = Effect.fnUntraced(function* (
  set: ViewSet,
  view: string,
  tenant: string,
  id: string,
  columns: string,
) {
  const sql = yield* SqlClient.SqlClient

  return yield* sql.unsafe<Row>(
    `SELECT ${columns} FROM ${set.name(view)}
      WHERE tenant_id = $1 AND actor_type = 'Specimen' AND actor_id = $2 ORDER BY 1`,
    [tenant, id],
  )
})

const COUNTED = [
  "actors",
  "state",
  "receipts",
  "events",
  "outbox",
  "timers",
  "jobs",
  "dead_letters",
]

const counts = Effect.fnUntraced(function* (set: ViewSet, tenant: string, id: string) {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* sql.unsafe<Record<string, number>>(
    `SELECT ${COUNTED.map(
      (view) => `(SELECT count(*)::int FROM ${set.name(view)}
        WHERE tenant_id = $1 AND actor_type = 'Specimen' AND actor_id = $2) AS ${view}`,
    ).join(", ")}`,
    [tenant, id],
  )

  const { jobs = 0, dead_letters = 0, ...rest } = row ?? {}

  return { ...rest, jobs: jobs + dead_letters }
})

const rejection = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String(exit.cause) : "succeeded"

const matching = (reason: string, pattern: RegExp) => ({ reason, matches: pattern.test(reason) })

class Probed extends Data.TaggedError("Probed")<{
  readonly visible: Record<string, number>
  readonly denied: Record<string, string>
  readonly write: string
}> {}

class Refused extends Data.TaggedError("Refused")<{
  readonly refusals: Record<string, string>
}> {}

const writesTo = (view: string) => {
  const column = view.endsWith("placements_v2")
    ? "actor_type"
    : view === "durable.views"
      ? "view_name"
      : "tenant_id"

  return [
    `INSERT INTO ${view} DEFAULT VALUES`,
    `UPDATE ${view} SET ${column} = ${column}`,
    `DELETE FROM ${view}`,
  ]
}

const casesFor = (set: ViewSet): ReadonlyArray<ConformanceCase> => {
  const id = (base: string) => `${base}-${set.key}`

  return [
    {
      name: `${set.label} show exactly the rows committed turns wrote`,
      run: ({ expect, environment }) =>
        environment.run(
          Effect.gen(function* () {
            const test = yield* ActorTest
            const tenant = test.tenant
            const specimen = yield* Specimen.get(id("flow"))
            yield* specimen.Record("first")

            expect(yield* counts(set, tenant, id("flow"))).toEqual({
              actors: 1,
              state: 1,
              receipts: 1,
              events: 1,
              outbox: 1,
              timers: 1,
              jobs: 1,
            })
            expect(
              yield* rowsOf(
                set,
                "actors",
                tenant,
                id("flow"),
                "actor_id, routing_key::text AS routing_key, generation::int AS generation, last_event_sequence::int AS last_event_sequence",
              ),
            ).toEqual([
              {
                actor_id: id("flow"),
                routing_key: routingKey({
                  ref: specimen.ref,
                  placement: "tenant",
                }).toString(),
                generation: 1,
                last_event_sequence: 1,
              },
            ])
            expect(
              yield* rowsOf(set, "state", tenant, id("flow"), "key, value_bytes > 0 AS stored"),
            ).toEqual([{ key: "notes", stored: true }])
            expect(
              yield* rowsOf(set, "receipts", tenant, id("flow"), "command, outcome_tag"),
            ).toEqual([{ command: "Record", outcome_tag: "Success" }])
            expect(
              yield* rowsOf(set, "events", tenant, id("flow"), "sequence::int AS sequence, event"),
            ).toEqual([{ sequence: 1, event: "Noted" }])
            expect(
              yield* rowsOf(
                set,
                "timers",
                tenant,
                id("flow"),
                "timer_key, target_type, target_id, command, due_at = to_timestamp(due_at_ms::float8 / 1000) AS dated",
              ),
            ).toEqual([
              {
                timer_key: "remind",
                target_type: "Specimen",
                target_id: id("flow"),
                command: "Remind",
                dated: true,
              },
            ])

            expect(
              Exit.isFailure(yield* specimen.RecordThenReject("second").pipe(Effect.exit)),
            ).toBe(true)
            expect(Exit.isFailure(yield* specimen.RecordThenDie("third").pipe(Effect.exit))).toBe(
              true,
            )
            expect(yield* counts(set, tenant, id("flow"))).toMatchObject({
              receipts: 2,
              events: 1,
              outbox: 1,
              timers: 1,
              jobs: 1,
            })
            expect(
              yield* rowsOf(set, "receipts", tenant, id("flow"), "command, outcome_tag"),
            ).toEqual([
              { command: "Record", outcome_tag: "Success" },
              { command: "RecordThenReject", outcome_tag: "Failure" },
            ])

            yield* test.advance(0)
            expect(yield* rowsOf(set, "jobs", tenant, id("flow"), "job")).toEqual([])
            expect(
              yield* rowsOf(set, "dead_letters", tenant, id("flow"), "job, attempts, ambiguous"),
            ).toEqual([{ job: "Deliver", attempts: 1, ambiguous: false }])

            yield* test.advance("1 hour")
            expect(yield* counts(set, tenant, id("flow"))).toMatchObject({
              outbox: 0,
              timers: 0,
            })
            expect(yield* test.receiptsFor(specimen.ref, "Remind")).toBe(1)
          }),
        ),
    },
    {
      name: `${set.label} carry each row's tenant and never merge tenants`,
      run: ({ expect, environment }) =>
        environment.run(
          Effect.gen(function* () {
            const test = yield* ActorTest
            const abroad = `${test.tenant}-b`
            yield* (yield* Specimen.get(id("shared-id"))).Record("home")
            yield* (yield* Specimen.get(id("shared-id")).pipe(Actor.tenant(abroad))).Record(
              "abroad",
            )
            yield* (yield* Specimen.get(id("shared-id")).pipe(Actor.tenant(abroad))).Record("again")

            const home = yield* counts(set, test.tenant, id("shared-id"))
            const other = yield* counts(set, abroad, id("shared-id"))

            expect(home).toMatchObject({
              actors: 1,
              receipts: 1,
              events: 1,
              jobs: 1,
            })
            expect(other).toMatchObject({
              actors: 1,
              receipts: 2,
              events: 2,
              jobs: 2,
            })

            const sql = yield* SqlClient.SqlClient

            for (const view of ["actors", "state", "receipts", "events", "outbox", "timers"]) {
              const tenants = yield* sql.unsafe<{ tenant_id: string }>(
                `SELECT DISTINCT tenant_id FROM ${set.name(view)}
                WHERE actor_type = 'Specimen' AND actor_id = '${id("shared-id")}' ORDER BY tenant_id`,
              )

              expect(tenants.map(({ tenant_id }) => tenant_id)).toEqual(
                [test.tenant, abroad].sort(),
              )
            }
          }),
        ),
    },
    {
      name: `${set.label} reject every write and leave the runtime rows untouched`,
      run: ({ expect, environment }) =>
        environment.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const test = yield* ActorTest
            yield* (yield* Specimen.get(id("frozen"))).Record("kept")
            const before = yield* counts(set, test.tenant, id("frozen"))
            const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)
            const owner = `owner_${uuid.replaceAll("-", "")}`
            const views = [...set.views.map(set.name), "durable.views"]

            const refusals = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe(`CREATE ROLE ${owner} NOLOGIN`)
                  yield* sql.unsafe(`GRANT USAGE ON SCHEMA durable TO ${owner}`)
                  const refusals: Record<string, string> = {}

                  for (const view of views) {
                    yield* sql.unsafe(`ALTER VIEW ${view} OWNER TO ${owner}`)
                    yield* sql.unsafe(`SET LOCAL ROLE ${owner}`)

                    for (const write of writesTo(view))
                      refusals[write] = rejection(
                        yield* sql.unsafe(write).pipe(sql.withTransaction, Effect.exit),
                      )

                    yield* sql.unsafe("RESET ROLE")
                  }

                  return yield* new Refused({ refusals })
                }),
              )
              .pipe(Effect.catchTag("Refused", ({ refusals }) => Effect.succeed(refusals)))

            for (const reason of Object.values(refusals))
              expect(
                matching(reason, /cannot (insert into|update|delete from) view|permission denied/),
              ).toMatchObject({ matches: true })

            expect(Object.keys(refusals).length).toBe(views.length * 3)
            expect(
              yield* sql<{ roles: number }>`
              SELECT count(*)::int AS roles FROM pg_roles WHERE rolname = ${owner}`,
            ).toEqual([{ roles: 0 }])
            expect(yield* counts(set, test.tenant, id("frozen"))).toEqual(before)
          }),
        ),
    },
    {
      name: `${set.label} are listed in the catalog with their versions`,
      run: ({ expect, environment }) =>
        environment.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient

            const listed = yield* sql<{ view_name: string; version: number }>`
            SELECT view_name, version FROM durable.views ORDER BY view_name COLLATE "C"`

            const expected = [
              ...FIRST_SET.views.map((view) => [view, FIRST_SET.versions[view] ?? 1] as const),
              ...SINGLE_TABLE_SET.views.map((view) => [`${view}_v2`, 1] as const),
              ["views", 1] as const,
            ]
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .map(([view_name, version]) => ({ view_name, version }))

            expect(listed).toEqual(expected)

            for (const { view_name } of listed)
              expect(
                Exit.isSuccess(
                  yield* sql.unsafe(`SELECT 1 FROM durable.${view_name} LIMIT 1`).pipe(Effect.exit),
                ),
              ).toBe(true)
          }),
        ),
    },
    {
      name: `a role granted only the durable schema reads the ${set.label} and no runtime table`,
      run: ({ expect, environment }) =>
        environment.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const test = yield* ActorTest
            yield* (yield* Specimen.get(id("granted"))).Record("visible")
            const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)
            const role = `inspector_${uuid.replaceAll("-", "")}`

            const probe = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe(`CREATE ROLE ${role} NOLOGIN`)
                  yield* sql.unsafe(`GRANT USAGE ON SCHEMA durable TO ${role}`)
                  yield* sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA durable TO ${role}`)
                  yield* sql.unsafe(`SET LOCAL ROLE ${role}`)
                  const visible = yield* counts(set, test.tenant, id("granted"))
                  const denied: Record<string, string> = {}

                  for (const table of [
                    "actor_generations",
                    "actor_state",
                    "actor_receipts",
                    "actor_events",
                    "actor_outbox",
                    "actor_dead_letters",
                    "actor_workflow_executions",
                    "actor_workflow_step",
                    "actor_workflow_manifests",
                  ])
                    denied[table] = rejection(
                      yield* sql
                        .unsafe(`SELECT 1 FROM ${table} LIMIT 1`)
                        .pipe(sql.withTransaction, Effect.exit),
                    )

                  const write = rejection(
                    yield* sql
                      .unsafe(`DELETE FROM ${set.name("receipts")}`)
                      .pipe(sql.withTransaction, Effect.exit),
                  )

                  return yield* new Probed({ visible, denied, write })
                }),
              )
              .pipe(Effect.catchTag("Probed", Effect.succeed))

            expect(probe.visible).toMatchObject({
              actors: 1,
              receipts: 1,
              events: 1,
              jobs: 1,
            })

            for (const reason of Object.values(probe.denied))
              expect(matching(reason, /permission denied/)).toMatchObject({ matches: true })
            expect(
              matching(probe.write, /permission denied|cannot delete from view/),
            ).toMatchObject({
              matches: true,
            })
            expect(
              yield* sql<{ roles: number }>`
              SELECT count(*)::int AS roles FROM pg_roles WHERE rolname = ${role}`,
            ).toEqual([{ roles: 0 }])
          }),
        ),
    },
  ]
}

/** Inspection-view cases: views show exactly the committed rows per tenant and reject every write. */
export const inspectionViewsConformance: ReadonlyArray<ConformanceCase> = [
  ...casesFor(FIRST_SET),
  ...casesFor(SINGLE_TABLE_SET),
  {
    name: "placements_v2 holds each registered actor type's placement, which tools join by actor_type",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const specimen = yield* Specimen.get("placed")
          yield* specimen.Record("one")

          expect(
            yield* sql<{ actor_type: string; placement: string; parent_type: string | null }>`
              SELECT actor_type, placement, parent_type FROM durable.placements_v2
              WHERE actor_type = 'Specimen'`,
          ).toEqual([{ actor_type: "Specimen", placement: "tenant", parent_type: null }])

          expect(
            yield* sql`SELECT a.actor_id, p.placement
              FROM durable.actors_v2 a JOIN durable.placements_v2 p ON p.actor_type = a.actor_type
              WHERE a.tenant_id = ${test.tenant} AND a.actor_id = 'placed'`,
          ).toEqual([{ actor_id: "placed", placement: "tenant" }])
        }),
      ),
  },
]

/** Inspection-view actors. */
export const inspectionViewsSuite: ConformanceSuite = {
  layer: () => inspectionViewsLayer,
}
