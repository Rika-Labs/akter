import { Context, Crypto, Data, Effect, Exit, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { SqlClient } from "effect/sql"
import { Actor, Intent, Unauthorized, User } from "../../index.ts"
import { Inspector } from "../../runtime/index.ts"
import * as Queries from "../../runtime/inspector/queries.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase, ConformanceSuite } from "../conformance.ts"
import { Auth } from "../../runtime/index.ts"
import { serveFetch, zstdDecompress } from "./platform.ts"

const Noted = Actor.event("Noted", { body: Schema.String })

class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {}) {}

class Undeliverable extends Schema.TaggedError<Undeliverable>()("Undeliverable", {}) {}

const Notify = Actor.job("Notify", { payload: { body: Schema.String } })

const Write = Actor.command("Write", { payload: Schema.String })

const WriteThenReject = Actor.command("WriteThenReject", {
  payload: Schema.String,
  error: Rejected,
})

const WriteThenDie = Actor.command("WriteThenDie", { payload: Schema.String })

const Nudge = Actor.command("Nudge")

const Settle = Actor.workflow("Settle", {
  payload: { order: Schema.String },
  success: Schema.String,
  key: ({ order }) => order,
})

const Reserve = Settle.step("reserve", { payload: Schema.String, success: Schema.String })

const Pause = Settle.sleep("pause")

const Inspected = Actor.make("Inspected", {
  key: Schema.String,
  state: Actor.state({
    notes: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  events: [Noted],
  jobs: { Notify: { job: Notify, retry: { times: 0 } } },
  api: { Write, WriteThenReject, WriteThenDie, Settle },
  internal: { Nudge },
})

const write = Effect.fnUntraced(function* (body: string) {
  const turn = yield* Inspected.Turn
  yield* turn.state.set({ notes: [...turn.state.notes, body] })
  yield* turn.emit(Noted.make({ body }))
  const self = yield* Inspected.intents(turn.id)
  yield* self.Nudge().pipe(Intent.after("1 hour"), Intent.key("nudge"))
  yield* turn.enqueue(Notify.make({ body }))
})

export const inspectorLayer = Layer.mergeAll(
  Inspected.toLayer(
    Effect.succeed({
      Write: write,
      WriteThenReject: Effect.fnUntraced(function* (body: string) {
        yield* write(body)

        return yield* Rejected.make({})
      }),
      WriteThenDie: Effect.fnUntraced(function* (body: string) {
        yield* write(body)

        return yield* Effect.die(new Error("Inspected defect after writing"))
      }),
      Nudge: () => Effect.void,
      Settle: Effect.fnUntraced(function* ({ order }: { readonly order: string }) {
        const reserved = yield* Reserve.run(order, (id) => Effect.succeed(`held-${id}`))
        yield* Pause("10 seconds")

        return `${reserved}:settled`
      }),
    }),
  ),
  Inspected.toJobLayer(
    Effect.succeed({
      Notify: Effect.fnUntraced(function* () {
        return yield* Undeliverable.make({})
      }),
    }),
  ),
)

/** How many requests reached the operators' provider. */
const reached = { count: 0 }

const operators = Auth.make((request) =>
  Option.match(
    Headers.get(request.headers, "authorization").pipe(
      Option.map((header) => {
        reached.count += 1

        return header
      }),
    ),
    {
      onNone: () => Effect.fail(Unauthorized.make({ code: "missing_credentials" })),
      onSome: (header) => {
        const match = /^Bearer ([A-Za-z0-9._:-]+)$/.exec(header)

        return match === null
          ? Effect.fail(Unauthorized.make({ code: "invalid_credentials" }))
          : Effect.succeed({ tenant: match[1]!, caller: User.make({ subject: "operator" }) })
      },
    },
  ),
)

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/** Serves the inspector from a real listening server for the rest of the scope. */
const serveInspector = Effect.gen(function* () {
  const context = yield* Effect.context<SqlClient.SqlClient>()

  const web = HttpRouter.toWebHandler(
    Inspector.serve({ auth: operators }).pipe(Layer.provide(Layer.succeedContext(context))),
    { disableLogger: true },
  )

  yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))
  const port = yield* serveFetch((request) => web.handler(request))

  const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient)

  const url = `http://127.0.0.1:${port}`

  return (path: string, tenant?: string, origin?: string) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.get(`${url}/inspector${path}`, {
        headers: origin === undefined ? {} : { origin: origin === "self" ? url : origin },
      })

      const response = yield* client.execute(
        tenant === undefined ? request : HttpClientRequest.bearerToken(request, tenant),
      )

      return { status: response.status, body: yield* decodeJson(yield* response.text) }
    }).pipe(Effect.orDie)
})

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Json))

const isArray = Schema.is(Schema.Array(Schema.Json))

const isNumber = Schema.is(Schema.Finite)

/** A field of a decoded JSON body, without trusting its shape. */
const field = (value: Schema.Json, ...path: ReadonlyArray<string | number>): Schema.Json => {
  let current: Schema.Json = value

  for (const key of path)
    current = isArray(current)
      ? (current[Number(key)] ?? null)
      : isRecord(current)
        ? (current[key] ?? null)
        : null

  return current
}

const list = (value: Schema.Json, ...path: ReadonlyArray<string | number>) => {
  const found = field(value, ...path)

  return isArray(found) ? found : []
}

const text = (value: Schema.Json) => (Schema.is(Schema.String)(value) ? value : "")

const numeral = (value: Schema.Json) => (isNumber(value) ? String(value) : "")

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const decodeJsonSync = (json: string) => Option.getOrThrow(parseJson(json))

/** Independent decode of a compressed view value: the bytes as Postgres stores them. */
const rawJson = (bytes: Uint8Array) =>
  decodeJsonSync(new TextDecoder().decode(zstdDecompress(bytes)))

const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, what: string) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("25 millis"), until: (held) => held }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${what}`)),
    }),
    Effect.asVoid,
  )

const tenantCounts = Effect.fnUntraced(function* (tenant: string) {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* sql<Record<string, number>>`
    SELECT
      (SELECT count(*)::int FROM durable.actors WHERE tenant_id = ${tenant}) AS actors,
      (SELECT count(*)::int FROM durable.receipts WHERE tenant_id = ${tenant}) AS receipts,
      (SELECT count(*)::int FROM durable.events WHERE tenant_id = ${tenant}) AS events,
      (SELECT count(*)::int FROM durable.outbox WHERE tenant_id = ${tenant}) AS outbox,
      (SELECT count(*)::int FROM durable.timers WHERE tenant_id = ${tenant}) AS timers,
      (SELECT count(*)::int FROM durable.jobs WHERE tenant_id = ${tenant}) AS jobs,
      (SELECT count(*)::int FROM durable.dead_letters WHERE tenant_id = ${tenant}) AS "deadLetters",
      (SELECT count(*)::int FROM durable.workflows WHERE tenant_id = ${tenant}) AS workflows,
      (SELECT count(*)::int FROM durable.workflows
        WHERE tenant_id = ${tenant} AND status <> 'finished') AS "openWorkflows"`

  return row!
})

const RUNTIME_TABLES = [
  "actor_generations",
  "actor_state",
  "actor_receipts",
  "actor_events",
  "actor_outbox",
  "actor_dead_letters",
  "actor_workflow_executions",
  "actor_workflow_step",
] as const

const fingerprint = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* sql.unsafe<Record<string, string>>(
    `SELECT ${RUNTIME_TABLES.map(
      (table) =>
        `(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, ',' ORDER BY t::text)), '')
          FROM ${table} t WHERE t.actor_type = 'Inspected') AS ${table}`,
    ).join(", ")}`,
  )

  return row!
})

const rejection = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String(exit.cause) : "succeeded"

class Probed extends Data.TaggedError("Probed")<{
  readonly found: boolean
  readonly listed: number
  readonly denied: string
}> {}

/** Inspector cases: decoded committed rows and events, workflow step history, and tenant scoping by the authenticated principal. */
export const inspectorConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "inspector: shows an actor's committed rows decoded, with the events each receipt committed",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sql = yield* SqlClient.SqlClient
          const get = yield* serveInspector
          const inspected = yield* Inspected.get("flow")
          yield* inspected.Write("first")
          yield* inspected.WriteThenReject("second").pipe(Effect.exit)
          yield* inspected.WriteThenDie("third").pipe(Effect.exit)
          yield* test.advance(0)

          const detail = yield* get("/actor?type=Inspected&id=flow", test.tenant)
          expect(detail.status).toBe(200)

          const [stored] = yield* sql<{
            generation: number
            created: boolean
            last_event_sequence: number
          }>`SELECT generation::int AS generation, created, last_event_sequence::int AS last_event_sequence
              FROM durable.actors
              WHERE tenant_id = ${test.tenant} AND actor_type = 'Inspected' AND actor_id = 'flow'`

          expect(field(detail.body, "actor")).toEqual({
            actorType: "Inspected",
            actorId: "flow",
            placement: "tenant",
            generation: stored!.generation,
            created: stored!.created,
            lastEventSequence: stored!.last_event_sequence,
          })
          expect(field(detail.body, "state")).toMatchObject([
            { key: "notes", value: { json: ["first"] } },
          ])

          const [event] = yield* sql<{ value: Uint8Array; command_id: string }>`
            SELECT value, command_id FROM durable.events
            WHERE tenant_id = ${test.tenant} AND actor_type = 'Inspected' AND actor_id = 'flow'`

          expect(field(detail.body, "events")).toMatchObject([
            {
              sequence: 1,
              event: "Noted",
              commandId: event!.command_id,
              value: { json: rawJson(event!.value) },
            },
          ])

          const receipts = list(detail.body, "receipts").toSorted((left, right) =>
            text(field(left, "command")).localeCompare(text(field(right, "command"))),
          )

          expect(receipts).toMatchObject([
            { command: "Write", commandId: event!.command_id, outcomeTag: "Success", events: [1] },
            { command: "WriteThenReject", outcomeTag: "Failure", events: [] },
          ])
          expect(field(detail.body, "outbox")).toMatchObject([
            {
              timerKey: "nudge",
              targetType: "Inspected",
              targetId: "flow",
              command: "Nudge",
              attempts: 0,
            },
          ])

          const [dead] = yield* sql<{ payload: string }>`
            SELECT payload FROM durable.dead_letters
            WHERE tenant_id = ${test.tenant} AND actor_type = 'Inspected' AND actor_id = 'flow'`

          expect(field(detail.body, "jobs")).toEqual([])
          expect(field(detail.body, "deadLetters")).toMatchObject([
            {
              job: "Notify",
              attempts: 1,
              ambiguous: false,
              payload: { json: decodeJsonSync(dead!.payload) },
            },
          ])
          expect(field(detail.body, "totals")).toEqual({
            receipts: 2,
            events: 1,
            outbox: 1,
            jobs: 0,
            deadLetters: 1,
            workflows: 0,
          })

          expect(
            list((yield* get("/actors?type=Inspected", test.tenant)).body, "actors").map((row) =>
              field(row, "actorId"),
            ),
          ).toContain("flow")

          const overview = yield* get("/overview", test.tenant)
          expect(field(overview.body, "tenant")).toBe(test.tenant)
          expect(field(overview.body, "counts")).toEqual(yield* tenantCounts(test.tenant))
          expect(field(overview.body, "views")).toEqual(
            (yield* sql<{ view_name: string; version: number }>`
              SELECT view_name, version FROM durable.views ORDER BY view_name COLLATE "C"`).map(
              ({ view_name, version }) => ({ view: view_name, version }),
            ),
          )

          const missing = yield* get("/actor?type=Inspected&id=never-written", test.tenant)
          expect(missing.status).toBe(404)
          expect(field(missing.body, "_tag")).toBe("NotFound")

          expect((yield* get("/actors?limit=0", test.tenant)).status).toBe(400)
        }),
      ),
  },
  {
    name: "inspector: pages an actor's receipts, timeline and latest events, counts actor and job types, and finds actors by address prefix",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sql = yield* SqlClient.SqlClient
          const get = yield* serveInspector
          const tenant = test.tenant
          const paged = yield* Inspected.get("paged")
          yield* paged.Write("one")
          yield* paged.Write("two")
          yield* paged.WriteThenReject("three").pipe(Effect.exit)
          yield* (yield* Inspected.get("pages")).Write("other")
          yield* (yield* Inspected.get("unpaged")).Write("apart")
          yield* test.advance(0)

          const byCodeUnit = (left: string, right: string) =>
            left < right ? -1 : left > right ? 1 : 0

          const stored = yield* sql<{
            actor_id: string
            command_id: string
            command: string
            caller_key: string
            outcome_tag: string
            expires_at_ms: string
          }>`SELECT actor_id, command_id, command, caller_key, outcome_tag, expires_at_ms::text
              FROM durable.receipts WHERE tenant_id = ${tenant}`

          const receiptOrder = (left: (typeof stored)[number], right: (typeof stored)[number]) =>
            Number(right.expires_at_ms) - Number(left.expires_at_ms) ||
            byCodeUnit(left.actor_id, right.actor_id) ||
            byCodeUnit(left.command_id, right.command_id)

          const expectedReceipts = (rows: typeof stored) =>
            rows.toSorted(receiptOrder).map((row) => ({
              actorId: row.actor_id,
              commandId: row.command_id,
              command: row.command,
              outcomeTag: row.outcome_tag,
              callerKey: { json: decodeJsonSync(row.caller_key) },
              expiresAtMs: Number(row.expires_at_ms),
            }))

          const pages = Effect.fnUntraced(function* (
            path: string,
            key: string,
            cursor: (next: Schema.Json) => string,
          ) {
            const rows: Array<Schema.Json> = []
            let after = ""

            for (let page = 0; page < 50; page++) {
              const reply = yield* get(`${path}${after}`, tenant)
              expect([path, reply.status]).toEqual([path, 200])
              rows.push(...list(reply.body, key))
              const next = field(reply.body, "next")

              if (next === null) return rows

              after = cursor(next)
            }

            return yield* Effect.die(new Error(`${path} never reached its last page`))
          })

          const receiptCursor = (next: Schema.Json) =>
            `&afterExpiresAtMs=${numeral(field(next, "expiresAtMs"))}&afterType=${encodeURIComponent(text(field(next, "actorType")))}&afterId=${encodeURIComponent(text(field(next, "actorId")))}&afterCommandId=${encodeURIComponent(text(field(next, "commandId")))}`

          const ownReceipts = yield* pages(
            "/receipts?type=Inspected&id=paged&limit=1",
            "receipts",
            receiptCursor,
          )
          expect(ownReceipts.length).toBe(3)
          expect(ownReceipts).toMatchObject(
            expectedReceipts(stored.filter((row) => row.actor_id === "paged")),
          )

          expect(yield* pages("/receipts?limit=2", "receipts", receiptCursor)).toMatchObject(
            expectedReceipts(stored),
          )
          expect(
            list((yield* get("/receipts?outcome=Failure", tenant)).body, "receipts"),
          ).toMatchObject(expectedReceipts(stored.filter((row) => row.outcome_tag === "Failure")))
          expect((yield* get("/receipts?type=Inspected&id=never", tenant)).status).toBe(404)
          expect((yield* get("/receipts?id=paged", tenant)).status).toBe(400)

          const events = yield* sql<{
            sequence: number
            event: string
            command_id: string
            emitted_at_ms: string
          }>`SELECT sequence::int AS sequence, event, command_id, emitted_at_ms::text
              FROM durable.events
              WHERE tenant_id = ${tenant} AND actor_type = 'Inspected' AND actor_id = 'paged'`
          expect(events.length).toBe(2)

          const callerOf = (commandId: string) => {
            const receipt = stored.find(
              (row) => row.actor_id === "paged" && row.command_id === commandId,
            )

            return receipt === undefined ? null : { json: decodeJsonSync(receipt.caller_key) }
          }

          const commands = [...new Set(events.map((event) => event.command_id))].map(
            (commandId) => {
              const own = events.filter((event) => event.command_id === commandId)

              return {
                kind: "command",
                sequence: Math.min(...own.map((event) => event.sequence)),
                name: stored.find((row) => row.command_id === commandId)!.command,
                commandId,
                callerKey: callerOf(commandId),
                atMs: Math.min(...own.map((event) => Number(event.emitted_at_ms))),
              }
            },
          )

          const expectedTimeline = [
            ...events.map((event) => ({
              kind: "event",
              sequence: event.sequence,
              name: event.event,
              commandId: event.command_id,
              callerKey: callerOf(event.command_id),
              atMs: Number(event.emitted_at_ms),
            })),
            ...commands,
          ].toSorted(
            (left, right) =>
              right.sequence - left.sequence ||
              Number(right.kind === "event") - Number(left.kind === "event"),
          )
          expect(expectedTimeline.map((entry) => entry.kind)).toEqual([
            "event",
            "command",
            "event",
            "command",
          ])

          expect(
            yield* pages(
              "/timeline?type=Inspected&id=paged&limit=3",
              "entries",
              (next) =>
                `&beforeSequence=${numeral(field(next, "sequence"))}&beforeKind=${text(field(next, "kind"))}`,
            ),
          ).toEqual(expectedTimeline)

          const newest = events.toSorted((left, right) => right.sequence - left.sequence)[0]!
          expect(
            yield* pages(
              "/latest-events?type=Inspected&id=paged&limit=1",
              "events",
              (next) => `&after=${encodeURIComponent(text(next))}`,
            ),
          ).toEqual([
            {
              event: "Noted",
              sequence: newest.sequence,
              emittedAtMs: Number(newest.emitted_at_ms),
            },
          ])

          const prefixed = (prefix: string) =>
            get(`/actors?prefix=${encodeURIComponent(prefix)}`, tenant).pipe(
              Effect.map((reply) => list(reply.body, "actors").map((row) => field(row, "actorId"))),
            )

          expect(yield* prefixed("Inspected/page")).toEqual(["paged", "pages"])
          expect(yield* prefixed("Inspected/paged")).toEqual(["paged"])
          const actorRows = yield* sql<{ actor_type: string; actor_id: string }>`
            SELECT actor_type, actor_id FROM durable.actors WHERE tenant_id = ${tenant}`
          expect(yield* prefixed("Insp")).toEqual(
            actorRows
              .filter((row) => row.actor_type === "Inspected")
              .map((row) => row.actor_id)
              .toSorted(byCodeUnit),
          )
          expect(yield* prefixed("Inspected/zz")).toEqual([])
          expect(yield* prefixed("Other")).toEqual([])

          expect(
            yield* pages("/actor-types?limit=1", "actorTypes", (next) => `&after=${text(next)}`),
          ).toEqual([{ actorType: "Inspected", actors: actorRows.length }])
          expect(field((yield* get("/actor-types?type=Missing", tenant)).body)).toMatchObject({
            actorTypes: [],
            next: null,
          })

          const pending = yield* sql<{ job: string; attempts: number }>`
            SELECT job, attempts::int AS attempts FROM durable.jobs WHERE tenant_id = ${tenant}`
          const dead = yield* sql<{ job: string; job_id: string; dead_at_ms: string }>`
            SELECT job, job_id, dead_at_ms::text FROM durable.dead_letters
            WHERE tenant_id = ${tenant}`
          expect(dead.length >= 4).toBe(true)

          expect(
            yield* pages("/job-types?limit=1", "jobTypes", (next) => `&after=${text(next)}`),
          ).toEqual(
            [...new Set([...pending, ...dead].map((row) => row.job))]
              .toSorted(byCodeUnit)
              .map((job) => ({
                job,
                queued: pending.filter((row) => row.job === job && row.attempts === 0).length,
                retrying: pending.filter((row) => row.job === job && row.attempts > 0).length,
                deadLetters: dead.filter((row) => row.job === job).length,
              })),
          )

          expect(
            (yield* pages(
              "/dead-letters?limit=1",
              "deadLetters",
              (next) =>
                `&afterDeadAtMs=${numeral(field(next, "deadAtMs"))}&afterJobId=${encodeURIComponent(text(field(next, "jobId")))}`,
            )).map((row) => field(row, "jobId")),
          ).toEqual(
            dead
              .toSorted(
                (left, right) =>
                  Number(right.dead_at_ms) - Number(left.dead_at_ms) ||
                  byCodeUnit(left.job_id, right.job_id),
              )
              .map((row) => row.job_id),
          )

          const [timer] = yield* sql<{ due: string | null }>`
            SELECT min(due_at_ms)::text AS due FROM durable.timers WHERE tenant_id = ${tenant}`
          expect(timer!.due).not.toBe(null)
          expect(field((yield* get("/overview", tenant)).body, "nextTimerDueAtMs")).toBe(
            Number(timer!.due),
          )
        }),
      ),
  },
  {
    name: "inspector: shows a workflow's step history while open and its result once finished",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sql = yield* SqlClient.SqlClient
          const get = yield* serveInspector
          const inspected = yield* Inspected.get("settling")
          const run = yield* inspected.Settle({ order: "o-1" })

          yield* eventually(
            Effect.gen(function* () {
              const rows = yield* sql<{ status: string }>`
                SELECT status FROM durable.workflows WHERE execution_id = ${run.executionId}`

              return rows[0]?.status === "suspended"
            }).pipe(Effect.orDie),
            "the execution to suspend",
          )

          const [reserve] = yield* sql<{ exit: Uint8Array }>`
            SELECT exit FROM durable.workflow_steps
            WHERE execution_id = ${run.executionId} AND step = 'reserve'`

          const [started] = yield* sql<{ payload: Uint8Array }>`
            SELECT payload FROM durable.workflows WHERE execution_id = ${run.executionId}`

          const open = yield* get("/actor?type=Inspected&id=settling", test.tenant)

          expect(field(open.body, "workflows")).toMatchObject([
            {
              executionId: run.executionId,
              workflow: "Settle",
              workflowKey: "o-1",
              status: "suspended",
              interrupt: false,
              result: null,
              finishedAtMs: null,
              steps: [
                { step: "reserve", kind: "activity", exit: { json: rawJson(reserve!.exit) } },
                { step: "pause", kind: "clock", exit: null },
              ],
            },
          ])
          expect(field(open.body, "workflows", 0, "payload")).toEqual({
            json: rawJson(started!.payload),
          })
          expect(isNumber(field(open.body, "workflows", 0, "steps", 1, "dueAtMs"))).toBe(true)

          const listed = (status: string) =>
            get(`/workflows?status=${status}`, test.tenant).pipe(
              Effect.map((reply) =>
                list(reply.body, "workflows").map((workflow) => field(workflow, "executionId")),
              ),
            )

          expect(yield* listed("open")).toContain(run.executionId)

          yield* test.advance("11 seconds")
          expect(yield* run.result).toBe("held-o-1:settled")

          const [finished] = yield* sql<{ result: Uint8Array }>`
            SELECT result FROM durable.workflows WHERE execution_id = ${run.executionId}`

          const done = yield* get("/actor?type=Inspected&id=settling", test.tenant)

          expect(field(done.body, "workflows")).toMatchObject([
            {
              executionId: run.executionId,
              status: "finished",
              result: { json: rawJson(finished!.result) },
              steps: [],
            },
          ])
          expect(yield* listed("open")).not.toContain(run.executionId)
          expect(yield* listed("all")).toContain(run.executionId)
          expect(yield* listed("finished")).toContain(run.executionId)
          expect(yield* listed("suspended")).not.toContain(run.executionId)

          const second = yield* (yield* Inspected.get("settling-again")).Settle({ order: "o-2" })

          yield* eventually(
            Effect.map(listed("suspended"), (ids) => ids.includes(second.executionId)),
            "the second execution to suspend",
          )
          expect(yield* listed("running")).not.toContain(second.executionId)

          const everyExecution: Array<Schema.Json> = []
          let after = ""

          for (let page = 0; page < 10; page++) {
            const reply = (yield* get(`/workflows?status=all&limit=1${after}`, test.tenant)).body
            everyExecution.push(...list(reply, "workflows").map((row) => field(row, "executionId")))
            const next = field(reply, "next")

            if (next === null) break

            after = `&afterStartedAtMs=${numeral(field(next, "startedAtMs"))}&afterExecutionId=${text(field(next, "executionId"))}`
          }

          expect(everyExecution).toEqual(yield* listed("all"))
          expect(everyExecution.length).toBe(2)
        }),
      ),
  },
  {
    name: "inspector: reads only the authenticated principal's tenant, refuses missing credentials, and refuses an oversized one before its provider runs",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const get = yield* serveInspector
          const home = test.tenant
          const abroad = `${test.tenant}-inspected`
          yield* (yield* Inspected.get("shared")).Write("home")
          yield* (yield* Inspected.get("shared").pipe(Actor.tenant(abroad))).Write("abroad")
          yield* (yield* Inspected.get("only-abroad").pipe(Actor.tenant(abroad))).Write("abroad")
          yield* test.advance(0)

          const shared = yield* get("/actor?type=Inspected&id=shared", home)
          expect(field(shared.body, "state")).toMatchObject([{ value: { json: ["home"] } }])
          expect(field(shared.body, "totals", "receipts")).toBe(1)

          expect(yield* get(`/actor?type=Inspected&id=shared&tenant=${abroad}`, home)).toEqual(
            shared,
          )
          expect((yield* get("/actor?type=Inspected&id=only-abroad", home)).status).toBe(404)
          expect(
            field((yield* get("/actor?type=Inspected&id=only-abroad", abroad)).body, "state"),
          ).toMatchObject([{ value: { json: ["abroad"] } }])

          const homeActors = list((yield* get("/actors?type=Inspected", home)).body, "actors")
          expect(homeActors.map((row) => field(row, "actorId"))).not.toContain("only-abroad")

          expect(
            list((yield* get("/actors?type=Inspected", abroad)).body, "actors").map((row) =>
              field(row, "actorId"),
            ),
          ).toEqual(["only-abroad", "shared"])

          for (const tenant of [home, abroad])
            expect(field((yield* get("/overview", tenant)).body, "counts")).toEqual(
              yield* tenantCounts(tenant),
            )

          const abroadLetters = list((yield* get("/dead-letters", abroad)).body, "deadLetters")
          expect(
            abroadLetters
              .map((row) => text(field(row, "actorId")))
              .toSorted((left, right) => left.localeCompare(right)),
          ).toEqual(["only-abroad", "shared"])

          for (const path of [
            "/receipts?type=Inspected&id=only-abroad",
            "/latest-events?type=Inspected&id=only-abroad",
            "/timeline?type=Inspected&id=only-abroad",
          ])
            expect((yield* get(path, home)).status).toBe(404)

          const receiptActors = (tenant: string) =>
            get("/receipts", tenant).pipe(
              Effect.map((reply) =>
                list(reply.body, "receipts")
                  .map((row) => text(field(row, "actorId")))
                  .toSorted((left, right) => left.localeCompare(right)),
              ),
            )

          expect(yield* receiptActors(abroad)).toEqual(["only-abroad", "shared"])
          expect(yield* receiptActors(home)).not.toContain("only-abroad")
          expect(field((yield* get("/actor-types", abroad)).body, "actorTypes")).toEqual([
            { actorType: "Inspected", actors: 2 },
          ])
          expect(field((yield* get("/actor-types", home)).body, "actorTypes")).toEqual([
            { actorType: "Inspected", actors: (yield* tenantCounts(home)).actors },
          ])
          expect(
            list((yield* get("/job-types", abroad)).body, "jobTypes").map((row) =>
              field(row, "deadLetters"),
            ),
          ).toEqual([2])
          expect(list((yield* get("/actors?prefix=Inspected/only", home)).body, "actors")).toEqual(
            [],
          )

          for (const path of ["/overview", "/actors", "/actor?type=Inspected&id=shared"]) {
            const anonymous = yield* get(path)
            expect(anonymous.status).toBe(401)
            expect(field(anonymous.body, "reason", "_tag")).toBe("Unauthorized")
            expect(field(anonymous.body, "reason", "code")).toBe("missing_credentials")
          }

          const foreign = yield* get(
            "/actor?type=Inspected&id=shared",
            home,
            "https://elsewhere.example",
          )

          expect(foreign.status).toBe(403)
          expect(field(foreign.body, "reason", "code")).toBe("origin_not_allowed")
          expect(field(foreign.body, "state")).toBe(null)
          expect(yield* get("/actor?type=Inspected&id=shared", home, "self")).toEqual(shared)

          const before = reached.count
          const oversized = yield* get("/overview", "a".repeat(9 * 1024))

          expect(oversized.status).toBe(413)
          expect(field(oversized.body, "reason", "code")).toBe("too_large")
          expect(reached.count).toBe(before)

          const everyone = list((yield* get("/actors?type=Inspected", abroad)).body, "actors")
          const paged: Array<Schema.Json> = []
          let cursor = ""

          for (let page = 0; page <= everyone.length; page++) {
            const reply = (yield* get(`/actors?type=Inspected&limit=1${cursor}`, abroad)).body
            paged.push(...list(reply, "actors"))
            const next = field(reply, "next")

            if (next === null) break

            cursor = `&afterType=${encodeURIComponent(text(field(next, "actorType")))}&afterId=${encodeURIComponent(text(field(next, "actorId")))}`
          }

          expect(paged).toEqual(everyone)
        }),
      ),
  },
  {
    name: "inspector: reads through the durable views only and never writes",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sql = yield* SqlClient.SqlClient
          const get = yield* serveInspector
          const inspected = yield* Inspected.get("untouched")
          yield* inspected.Write("kept")
          yield* test.advance(0)
          const before = yield* fingerprint

          for (const path of [
            "/overview",
            "/actors",
            "/actor?type=Inspected&id=untouched",
            "/outbox",
            "/jobs",
            "/dead-letters",
            "/workflows?status=all",
            "/actor-types",
            "/job-types",
            "/receipts",
            "/receipts?type=Inspected&id=untouched",
            "/latest-events?type=Inspected&id=untouched",
            "/timeline?type=Inspected&id=untouched",
          ])
            expect((yield* get(path, test.tenant)).status).toBe(200)

          expect(yield* fingerprint).toEqual(before)

          const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)
          const role = `inspector_${uuid.replaceAll("-", "")}`

          const probe = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql.unsafe(`CREATE ROLE ${role} NOLOGIN`)
                yield* sql.unsafe(`GRANT USAGE ON SCHEMA durable TO ${role}`)
                yield* sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA durable TO ${role}`)
                yield* sql.unsafe(`SET LOCAL ROLE ${role}`)
                yield* sql`SET TRANSACTION READ ONLY`
                const page = { tenant: test.tenant, limit: 50 }
                yield* Queries.overview(page)
                const listed = yield* Queries.actors(page)
                yield* Queries.outbox(page)
                yield* Queries.jobs(page)
                yield* Queries.deadLetters(page)
                yield* Queries.workflows({ ...page, status: "all" })
                yield* Queries.actorTypes(page)
                yield* Queries.jobTypes(page)
                yield* Queries.receipts(page)
                const untouched = { ...page, actorType: "Inspected", actorId: "untouched" }
                yield* Queries.receipts(untouched)
                yield* Queries.latestEvents(untouched)
                yield* Queries.timeline(untouched)

                const found = yield* Queries.actor({
                  ...page,
                  actorType: "Inspected",
                  actorId: "untouched",
                })

                const denied = yield* sql`SELECT 1 FROM actor_receipts LIMIT 1`.pipe(
                  sql.withTransaction,
                  Effect.exit,
                  Effect.map(rejection),
                )

                return yield* new Probed({
                  found: Option.isSome(found),
                  listed: listed.actors.length,
                  denied,
                })
              }),
            )
            .pipe(Effect.catchTag("Probed", Effect.succeed))

          expect(probe.found).toBe(true)
          expect(probe.listed > 0).toBe(true)
          expect(/permission denied/.test(probe.denied)).toBe(true)

          const write = rejection(
            yield* Queries.readOnly(test.tenant)(sql`DELETE FROM actor_receipts`).pipe(Effect.exit),
          )

          expect(/read-only transaction/.test(write)).toBe(true)
          expect(yield* fingerprint).toEqual(before)
        }),
      ),
  },
]

/** Inspector actors. */
export const inspectorSuite: ConformanceSuite = {
  layer: () => inspectorLayer,
}
