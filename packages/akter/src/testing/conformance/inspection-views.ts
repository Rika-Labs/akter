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

const VIEWS = [
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
  "views",
  "operator_audit",
  "contents",
  "content_refs",
] as const

type Row = Record<string, string | number | boolean | null>

const rowsOf = Effect.fnUntraced(function* (
  view: (typeof VIEWS)[number],
  tenant: string,
  id: string,
  columns: string,
) {
  const sql = yield* SqlClient.SqlClient

  return yield* sql.unsafe<Row>(
    `SELECT ${columns} FROM durable.${view}
      WHERE tenant_id = $1 AND actor_type = 'Specimen' AND actor_id = $2 ORDER BY 1`,
    [tenant, id],
  )
})

const COUNTED = VIEWS.filter(
  (name) =>
    name !== "views" &&
    name !== "workflows" &&
    name !== "workflow_steps" &&
    name !== "operator_audit" &&
    name !== "contents" &&
    name !== "content_refs",
)

const counts = Effect.fnUntraced(function* (tenant: string, id: string) {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* sql.unsafe<Record<string, number>>(
    `SELECT ${COUNTED.map(
      (view) => `(SELECT count(*)::int FROM durable.${view}
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

/** Inspection-view cases: views show exactly the committed rows per tenant and reject every write. */
export const inspectionViewsConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "inspection views show exactly the rows committed turns wrote",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const tenant = test.tenant
          const specimen = yield* Specimen.get("flow")
          yield* specimen.Record("first")

          expect(yield* counts(tenant, "flow")).toEqual({
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
              "actors",
              tenant,
              "flow",
              "actor_id, routing_key::text AS routing_key, placement, generation::int AS generation, last_event_sequence::int AS last_event_sequence",
            ),
          ).toEqual([
            {
              actor_id: "flow",
              routing_key: routingKey({
                ref: specimen.ref,
                placement: "tenant",
              }).toString(),
              placement: "tenant",
              generation: 1,
              last_event_sequence: 1,
            },
          ])
          expect(yield* rowsOf("state", tenant, "flow", "key, value_bytes > 0 AS stored")).toEqual([
            { key: "notes", stored: true },
          ])
          expect(yield* rowsOf("receipts", tenant, "flow", "command, outcome_tag")).toEqual([
            { command: "Record", outcome_tag: "Success" },
          ])
          expect(
            yield* rowsOf("events", tenant, "flow", "sequence::int AS sequence, event"),
          ).toEqual([{ sequence: 1, event: "Noted" }])
          expect(
            yield* rowsOf(
              "timers",
              tenant,
              "flow",
              "timer_key, target_type, target_id, command, due_at = to_timestamp(due_at_ms::float8 / 1000) AS dated",
            ),
          ).toEqual([
            {
              timer_key: "remind",
              target_type: "Specimen",
              target_id: "flow",
              command: "Remind",
              dated: true,
            },
          ])

          expect(Exit.isFailure(yield* specimen.RecordThenReject("second").pipe(Effect.exit))).toBe(
            true,
          )
          expect(Exit.isFailure(yield* specimen.RecordThenDie("third").pipe(Effect.exit))).toBe(
            true,
          )
          expect(yield* counts(tenant, "flow")).toMatchObject({
            receipts: 2,
            events: 1,
            outbox: 1,
            timers: 1,
            jobs: 1,
          })
          expect(yield* rowsOf("receipts", tenant, "flow", "command, outcome_tag")).toEqual([
            { command: "Record", outcome_tag: "Success" },
            { command: "RecordThenReject", outcome_tag: "Failure" },
          ])

          yield* test.advance(0)
          expect(yield* rowsOf("jobs", tenant, "flow", "job")).toEqual([])
          expect(yield* rowsOf("dead_letters", tenant, "flow", "job, attempts, ambiguous")).toEqual(
            [{ job: "Deliver", attempts: 1, ambiguous: false }],
          )

          yield* test.advance("1 hour")
          expect(yield* counts(tenant, "flow")).toMatchObject({
            outbox: 0,
            timers: 0,
          })
          expect(yield* test.receiptsFor(specimen.ref, "Remind")).toBe(1)
        }),
      ),
  },
  {
    name: "inspection views carry each row's tenant and never merge tenants",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const abroad = `${test.tenant}-b`
          yield* (yield* Specimen.get("shared-id")).Record("home")
          yield* (yield* Specimen.get("shared-id").pipe(Actor.tenant(abroad))).Record("abroad")
          yield* (yield* Specimen.get("shared-id").pipe(Actor.tenant(abroad))).Record("again")

          const home = yield* counts(test.tenant, "shared-id")
          const other = yield* counts(abroad, "shared-id")

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
              `SELECT DISTINCT tenant_id FROM durable.${view}
                WHERE actor_type = 'Specimen' AND actor_id = 'shared-id' ORDER BY tenant_id`,
            )

            expect(tenants.map(({ tenant_id }) => tenant_id)).toEqual([test.tenant, abroad].sort())
          }
        }),
      ),
  },
  {
    name: "inspection views reject every write and leave the runtime rows untouched",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          yield* (yield* Specimen.get("frozen")).Record("kept")
          const before = yield* counts(test.tenant, "frozen")

          expect(
            yield* sql<{ view_name: string; version: number }>`
              SELECT view_name, version FROM durable.views ORDER BY view_name COLLATE "C"`,
          ).toEqual(
            [...VIEWS].sort().map((view_name) => ({
              view_name,
              version: view_name === "dead_letters" || view_name === "receipts" ? 2 : 1,
            })),
          )

          for (const view of VIEWS) {
            const column = view === "views" ? "view_name" : "tenant_id"

            for (const statement of [
              `INSERT INTO durable.${view} DEFAULT VALUES`,
              `UPDATE durable.${view} SET ${column} = ${column}`,
              `DELETE FROM durable.${view}`,
            ])
              expect(
                matching(
                  rejection(yield* sql.unsafe(statement).pipe(Effect.exit)),
                  /cannot (insert into|update|delete from) view/,
                ),
              ).toMatchObject({ matches: true })
          }

          expect(yield* counts(test.tenant, "frozen")).toEqual(before)
        }),
      ),
  },
  {
    name: "a role granted only the durable schema reads the views and no runtime table",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          yield* (yield* Specimen.get("granted")).Record("visible")
          const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)
          const role = `inspector_${uuid.replaceAll("-", "")}`

          const probe = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql.unsafe(`CREATE ROLE ${role} NOLOGIN`)
                yield* sql.unsafe(`GRANT USAGE ON SCHEMA durable TO ${role}`)
                yield* sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA durable TO ${role}`)
                yield* sql.unsafe(`SET LOCAL ROLE ${role}`)
                const visible = yield* counts(test.tenant, "granted")
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
                    .unsafe(`DELETE FROM durable.receipts`)
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
          expect(matching(probe.write, /permission denied|cannot delete from view/)).toMatchObject({
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

/** Inspection-view actors. */
export const inspectionViewsSuite: ConformanceSuite = {
  layer: () => inspectionViewsLayer,
}
