import {
  Context,
  Crypto,
  Data,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { SqlClient } from "effect/sql"
import { Actor, Actors, Intent, Unauthorized, User } from "../../../../packages/akter/src/index.ts"
import { Inspector } from "../../../../packages/akter/src/runtime/index.ts"
import { InternalActors } from "../../../../packages/akter/src/runtime/actors.ts"
import * as Queries from "../../../../packages/akter/src/runtime/inspector/queries.ts"
import { ActorTest } from "../../../../packages/akter/src/testing/actor-test.ts"
import type { ConformanceCase, ConformanceSuite } from "../conformance.ts"
import { Auth } from "../../../../packages/akter/src/runtime/index.ts"
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

const Sign = Actor.command("Sign", {
  payload: {
    profile: Schema.Struct({ nick: Schema.String, secretAnswer: Schema.String }),
    user: Schema.String,
    password: Schema.String,
    note: Schema.String,
    tags: Schema.Array(Schema.String),
  },
})

const Tick = Actor.command("Tick")

/** An actor whose only work is a once-a-minute cron tick. */
const Scheduled = Actor.make("InspectedSchedule", {
  key: Schema.String,
  api: { Nudge },
  internal: { Tick },
  schedules: { "* * * * *": Tick },
})

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
  api: { Write, WriteThenReject, WriteThenDie, Settle, Sign },
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
      Sign: () => Effect.void,
      Settle: Effect.fnUntraced(function* ({ order }: { readonly order: string }) {
        const reserved = yield* Reserve.run(order, (id) => Effect.succeed(`held-${id}`))
        yield* Pause("10 seconds")

        return `${reserved}:settled`
      }),
    }),
  ),
  Scheduled.toLayer(Effect.succeed({ Nudge: () => Effect.void, Tick: () => Effect.void })),
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

/** How long a case holds a turn before its handler, so its recorded duration must cover it. */
const HELD_MS = 200

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/** Serves the inspector from a real listening server for the rest of the scope. */
const serveInspector = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const runtime = yield* Effect.serviceOption(InternalActors)

  const context = Option.match(runtime, {
    onNone: () => Context.make(SqlClient.SqlClient, sql),
    onSome: (actors) =>
      Context.make(SqlClient.SqlClient, sql).pipe(Context.add(InternalActors, actors)),
  })

  const web = HttpRouter.toWebHandler(
    Inspector.serve({ auth: operators, runner: "runner-1", region: "test-region" }).pipe(
      Layer.provide(Layer.succeedContext(context)),
    ),
    { disableLogger: true },
  )

  yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))
  const port = yield* serveFetch((request) => web.handler(request))

  const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient)

  const url = `http://127.0.0.1:${port}`

  const get = (path: string, tenant?: string, origin?: string) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.get(`${url}/inspector${path}`, {
        headers: origin === undefined ? {} : { origin: origin === "self" ? url : origin },
      })

      const response = yield* client.execute(
        tenant === undefined ? request : HttpClientRequest.bearerToken(request, tenant),
      )

      return { status: response.status, body: yield* decodeJson(yield* response.text) }
    }).pipe(Effect.orDie)

  /**
   * Opens `/commands/stream` as `tenant` and collects its SSE messages, as
   * `{ event, id, data }`, until the scope closes.
   */
  const stream = (query: string, tenant: string) =>
    Effect.gen(function* () {
      const received: Array<{ event: string; id: string | undefined; data: Schema.Json }> = []
      const response = yield* client.execute(
        HttpClientRequest.bearerToken(
          HttpClientRequest.get(`${url}/inspector/commands/stream${query}`),
          tenant,
        ),
      )
      let buffered = ""

      yield* response.stream.pipe(
        Stream.decodeText,
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            buffered += chunk
            let end = buffered.indexOf("\n\n")

            while (end !== -1) {
              const block = buffered.slice(0, end)
              buffered = buffered.slice(end + 2)
              end = buffered.indexOf("\n\n")
              const lines = block.split("\n").filter((line) => !line.startsWith(":"))

              if (lines.length === 0) continue

              const value = (name: string) =>
                lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2)

              received.push({
                event: value("event") ?? "message",
                id: value("id"),
                data: decodeJsonSync(value("data") ?? "null"),
              })
            }
          }),
        ),
        Effect.forkScoped,
      )

      return { status: response.status, received }
    }).pipe(Effect.orDie)

  return Object.assign(get, { stream })
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

const byText = (left: string, right: string) => left.localeCompare(right)

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
          const tenant = `${test.tenant}-paged`
          const paged = yield* Inspected.get("paged").pipe(Actor.tenant(tenant))
          yield* paged.Write("one")
          yield* paged.Write("two")
          yield* paged.WriteThenReject("three").pipe(Effect.exit)
          yield* (yield* Inspected.get("pages").pipe(Actor.tenant(tenant))).Write("other")
          yield* (yield* Inspected.get("unpaged").pipe(Actor.tenant(tenant))).Write("apart")
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

          const cursorTail = "&afterType=Inspected&afterId=paged&afterCommandId=c"
          for (const path of [
            `/receipts?afterExpiresAtMs=1.5${cursorTail}`,
            `/receipts?afterExpiresAtMs=1e21${cursorTail}`,
            "/receipts?afterExpiresAtMs=1&afterType=Inspected",
            "/actors?afterType=Inspected",
            "/dead-letters?afterDeadAtMs=1",
            "/workflows?afterExecutionId=x",
            "/timeline?type=Inspected&id=paged&beforeSequence=2",
          ])
            expect([path, (yield* get(path, tenant)).status]).toEqual([path, 400])

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
          expect(yield* prefixed("Insp")).toEqual(["paged", "pages", "unpaged"])
          expect(yield* prefixed("Inspected/zz")).toEqual([])
          expect(yield* prefixed("Other")).toEqual([])

          expect(
            yield* pages("/actor-types?limit=1", "actorTypes", (next) => `&after=${text(next)}`),
          ).toEqual([{ actorType: "Inspected", actors: 3 }])
          expect(
            field((yield* get("/actor-types?prefix=Insp", tenant)).body, "actorTypes"),
          ).toEqual([{ actorType: "Inspected", actors: 3 }])
          expect(field((yield* get("/actor-types?prefix=Zed", tenant)).body, "actorTypes")).toEqual(
            [],
          )
          expect(field((yield* get("/actor-types?type=Missing", tenant)).body)).toMatchObject({
            actorTypes: [],
            next: null,
          })

          const pending = yield* sql<{ job: string; attempts: number }>`
            SELECT job, attempts::int AS attempts FROM durable.jobs WHERE tenant_id = ${tenant}`
          const dead = yield* sql<{ job: string; job_id: string; dead_at_ms: string }>`
            SELECT job, job_id, dead_at_ms::text FROM durable.dead_letters
            WHERE tenant_id = ${tenant}`
          expect(dead.length).toBe(4)

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
          expect(yield* listed("completed")).toContain(run.executionId)
          expect(yield* listed("failed")).not.toContain(run.executionId)
          expect(yield* listed("suspended")).not.toContain(run.executionId)

          const flows = `${test.tenant}-flows`
          const listedIn = (status: string) =>
            get(`/workflows?status=${status}`, flows).pipe(
              Effect.map((reply) =>
                list(reply.body, "workflows").map((workflow) => field(workflow, "executionId")),
              ),
            )
          const starts = yield* Effect.forEach(["a", "b"], (order) =>
            Inspected.get(`flow-${order}`).pipe(
              Effect.flatMap((actor) => actor.Settle({ order: `o-${order}` })),
              Actor.tenant(flows),
            ),
          )
          const executions = starts.map((start) => start.executionId)

          yield* eventually(
            Effect.map(listedIn("suspended"), (ids) => executions.every((id) => ids.includes(id))),
            "both executions to suspend",
          )
          expect(yield* listedIn("running")).toEqual([])

          const everyExecution: Array<Schema.Json> = []
          let after = ""

          for (let page = 0; page < 10; page++) {
            const reply = (yield* get(`/workflows?status=all&limit=1${after}`, flows)).body
            everyExecution.push(...list(reply, "workflows").map((row) => field(row, "executionId")))
            const next = field(reply, "next")

            if (next === null) break

            after = `&afterStartedAtMs=${numeral(field(next, "startedAtMs"))}&afterExecutionId=${text(field(next, "executionId"))}`
          }

          expect(everyExecution).toEqual(yield* listedIn("all"))
          expect(everyExecution.map(text).toSorted(byText)).toEqual(executions.toSorted(byText))
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
          const home = `${test.tenant}-home`
          const abroad = `${test.tenant}-inspected`
          yield* (yield* Inspected.get("shared").pipe(Actor.tenant(home))).Write("home")
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

          const sql = yield* SqlClient.SqlClient
          const commandsOf = (tenant: string) =>
            sql<{ command_id: string }>`
              SELECT command_id FROM durable.receipts
              WHERE tenant_id = ${tenant} AND actor_type = 'Inspected' AND actor_id = 'shared'`.pipe(
              Effect.map((rows) => rows.map((row) => row.command_id)),
            )
          const homeCommands = yield* commandsOf(home)
          const abroadCommands = yield* commandsOf(abroad)
          expect(homeCommands.length).toBe(1)
          expect(abroadCommands.length).toBe(1)
          expect(homeCommands).not.toEqual(abroadCommands)

          const [homeEvent] = yield* sql<{ sequence: number; command_id: string }>`
            SELECT sequence::int AS sequence, command_id FROM durable.events
            WHERE tenant_id = ${home} AND actor_type = 'Inspected' AND actor_id = 'shared'`
          expect(homeEvent!.command_id).toBe(homeCommands[0])

          const sharedAt = (path: string, key: string, name: string) =>
            get(`/${path}?type=Inspected&id=shared`, home).pipe(
              Effect.map((reply) => list(reply.body, key).map((row) => field(row, name))),
            )

          expect(yield* sharedAt("receipts", "receipts", "commandId")).toEqual(homeCommands)
          expect(yield* sharedAt("timeline", "entries", "commandId")).toEqual([
            homeCommands[0],
            homeCommands[0],
          ])
          expect(yield* sharedAt("latest-events", "events", "sequence")).toEqual([
            homeEvent!.sequence,
          ])

          const receiptActors = (tenant: string) =>
            get("/receipts", tenant).pipe(
              Effect.map((reply) =>
                list(reply.body, "receipts")
                  .map((row) => text(field(row, "actorId")))
                  .toSorted((left, right) => left.localeCompare(right)),
              ),
            )

          expect(yield* receiptActors(abroad)).toEqual(["only-abroad", "shared"])
          expect(yield* receiptActors(home)).toEqual(["shared"])
          expect(field((yield* get("/actor-types", abroad)).body, "actorTypes")).toEqual([
            { actorType: "Inspected", actors: 2 },
          ])
          expect(field((yield* get("/actor-types", home)).body, "actorTypes")).toEqual([
            { actorType: "Inspected", actors: 1 },
          ])
          expect(field((yield* get("/job-types", abroad)).body, "jobTypes")).toEqual([
            { job: "Notify", queued: 0, retrying: 0, deadLetters: 2 },
          ])
          expect(field((yield* get("/job-types", home)).body, "jobTypes")).toEqual([
            { job: "Notify", queued: 0, retrying: 0, deadLetters: 1 },
          ])
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
    name: "inspector: records each receipt's start and commit time on the database clock and an actor's last command",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sql = yield* SqlClient.SqlClient
          const get = yield* serveInspector
          const clock = sql<{ now: number }>`
            SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now`.pipe(
            Effect.map((rows) => rows[0]!.now),
          )

          const tenant = `${test.tenant}-timed`
          const before = yield* clock
          const timed = yield* Inspected.get("timed").pipe(Actor.tenant(tenant))
          const slow = yield* (yield* Actors).mintCommandId
          const held = yield* test.pauseNext("beforeHandler", { commandId: slow })
          const writing = yield* timed.Write("one").pipe(Actor.commandId(slow), Effect.forkChild)
          yield* held.reached
          yield* Effect.sleep(HELD_MS)
          yield* held.release
          yield* Fiber.join(writing)
          const between = yield* clock
          yield* timed.WriteThenReject("two").pipe(Effect.exit)
          yield* (yield* Inspected.get("other").pipe(Actor.tenant(tenant))).Write("three")
          const after = yield* clock

          const stored = yield* sql<{
            actor_id: string
            command: string
            command_id: string
            started_at_ms: number
            committed_at_ms: number
          }>`SELECT actor_id, command, command_id, started_at_ms::float8 AS started_at_ms,
                committed_at_ms::float8 AS committed_at_ms
              FROM actor_receipts WHERE tenant_id = ${tenant} AND actor_type = 'Inspected'
              ORDER BY committed_at_ms, command_id`

          expect(stored.map((row) => [row.actor_id, row.command])).toEqual([
            ["timed", "Write"],
            ["timed", "WriteThenReject"],
            ["other", "Write"],
          ])

          for (const row of stored) {
            expect(row.started_at_ms >= before).toBe(true)
            expect(row.committed_at_ms >= row.started_at_ms).toBe(true)
            expect(row.committed_at_ms <= after).toBe(true)
          }

          expect(stored[0]!.committed_at_ms <= between).toBe(true)
          expect(stored[0]!.command_id).toBe(slow)
          expect(stored[0]!.committed_at_ms - stored[0]!.started_at_ms >= HELD_MS).toBe(true)
          expect(stored[1]!.started_at_ms >= between).toBe(true)

          const [view] = yield* sql<{ duration_ms: number; committed_at: Date }>`
            SELECT duration_ms::float8 AS duration_ms, committed_at FROM durable.receipts
            WHERE tenant_id = ${tenant} AND command_id = ${stored[0]!.command_id}`
          expect(view!.duration_ms).toBe(stored[0]!.committed_at_ms - stored[0]!.started_at_ms)
          expect(view!.committed_at.getTime()).toBe(stored[0]!.committed_at_ms)

          const page = yield* get("/receipts?type=Inspected&id=timed", tenant)
          expect(
            list(page.body, "receipts")
              .map((row) => [
                field(row, "commandId"),
                field(row, "startedAtMs"),
                field(row, "committedAtMs"),
              ])
              .toSorted((left, right) => Number(left[2]) - Number(right[2])),
          ).toEqual(
            stored
              .filter((row) => row.actor_id === "timed")
              .map((row) => [row.command_id, row.started_at_ms, row.committed_at_ms]),
          )

          const actors = list((yield* get("/actors?type=Inspected", tenant)).body, "actors")
          const lastOf = (id: string) =>
            field(actors.find((row) => field(row, "actorId") === id) ?? null, "lastCommand")
          expect(lastOf("timed")).toEqual({
            command: "WriteThenReject",
            committedAtMs: stored[1]!.committed_at_ms,
          })
          expect(lastOf("other")).toEqual({
            command: "Write",
            committedAtMs: stored[2]!.committed_at_ms,
          })

          yield* sql`UPDATE actor_receipts SET committed_at_ms = NULL, started_at_ms = NULL
            WHERE tenant_id = ${tenant} AND actor_id = 'other'`
          const untimed = list((yield* get("/actors?type=Inspected", tenant)).body, "actors")
          expect(
            field(untimed.find((row) => field(row, "actorId") === "other") ?? null, "lastCommand"),
          ).toBe(null)
          expect(
            list((yield* get("/receipts?type=Inspected&id=other", tenant)).body, "receipts").map(
              (row) => [field(row, "startedAtMs"), field(row, "committedAtMs")],
            ),
          ).toEqual([[null, null]])
        }),
      ),
  },
  {
    name: "inspector: counts this runner's committed turns per tenant and type, streams them with redacted previews, and reads awake activations",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sql = yield* SqlClient.SqlClient
          const get = yield* serveInspector
          const home = `${test.tenant}-live`
          const abroad = `${test.tenant}-elsewhere`
          const inHome = (id: string) => Inspected.get(id).pipe(Actor.tenant(home))

          const watching = yield* get.stream("?type=Inspected", home)
          const failures = yield* get.stream("?outcome=Failure", home)
          const foreign = yield* get.stream("", abroad)
          expect([watching.status, failures.status, foreign.status]).toEqual([200, 200, 200])

          const a = yield* inHome("a")
          const b = yield* inHome("b")
          yield* a.Write("1")
          yield* a.Write("2")
          yield* b.Write("3")
          yield* a.WriteThenReject("4").pipe(Effect.exit)
          yield* a.WriteThenDie("5").pipe(Effect.exit)
          yield* b.Sign({
            profile: { nick: "ada", secretAnswer: "blue-moon" },
            user: "ada",
            password: "hunter2-is-secret",
            note: "x".repeat(40),
            tags: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"],
          })
          yield* (yield* Inspected.get("c").pipe(Actor.tenant(abroad))).Write("abroad")

          const receipts = yield* sql<{ command: string; count: number; commandIds: string }>`
            SELECT command, count(*)::int AS count,
              string_agg(command_id, ',' ORDER BY command_id) AS "commandIds"
            FROM actor_receipts WHERE tenant_id = ${home} AND actor_type = 'Inspected'
            GROUP BY command ORDER BY count(*) DESC, command COLLATE "C"`
          expect(receipts.map(({ command, count }) => ({ command, count }))).toEqual([
            { command: "Write", count: 3 },
            { command: "Sign", count: 1 },
            { command: "WriteThenReject", count: 1 },
          ])
          const written = receipts.reduce((sum, row) => sum + row.count, 0)

          const activity = yield* get("/live/activity?type=Inspected&window=1h", home)
          expect(activity.status).toBe(200)
          expect(field(activity.body, "scope")).toMatchObject({
            runner: "runner-1",
            region: "test-region",
          })
          expect(
            list(activity.body, "activity", "commands").map((row) => ({
              command: field(row, "command"),
              count: field(row, "count"),
            })),
          ).toEqual(receipts.map(({ command, count }) => ({ command, count })))
          const points = list(activity.body, "activity", "points")
          expect(points.length > 0).toBe(true)
          expect(points.length <= 60).toBe(true)
          expect(points.every((point) => Number(field(point, "perSecond")) >= 0)).toBe(true)

          const latency = yield* get("/live/latency?type=Inspected&window=24h", home)
          expect(field(latency.body, "latency", "count")).toBe(written)
          expect(
            list(latency.body, "latency", "buckets").reduce<number>(
              (sum, bucket) => sum + Number(field(bucket, "count")),
              0,
            ),
          ).toBe(written)
          expect(list(latency.body, "latency", "buckets").length).toBe(16)
          const p50 = Number(field(latency.body, "latency", "p50Ms"))
          const p99 = Number(field(latency.body, "latency", "p99Ms"))
          expect(p50 >= 0).toBe(true)
          expect(p99 >= p50).toBe(true)

          expect(
            list(
              (yield* get("/live/activity?type=Inspected&window=7d", abroad)).body,
              "activity",
              "commands",
            ),
          ).toMatchObject([{ command: "Write", count: 1 }])
          expect(
            list(
              (yield* get("/live/activity?type=Inspected&window=1h", `${test.tenant}-nobody`)).body,
              "activity",
              "commands",
            ),
          ).toEqual([])

          const overview = yield* get("/live/overview", home)
          const inspectedType = list(overview.body, "actorTypes").find(
            (row) => field(row, "actorType") === "Inspected",
          )
          expect(field(inspectedType ?? null, "awake")).toBe(2)
          expect(field(overview.body, "total", "awake")).toBe(2)
          expect(Number(field(inspectedType ?? null, "perSecond")) > 0).toBe(true)

          const named = yield* get(
            `/live/actors?type=Inspected&ids=${encodeURIComponent('["a","b","never"]')}`,
            home,
          )
          expect(
            list(named.body, "actors").map((row) => [field(row, "actorId"), field(row, "awake")]),
          ).toEqual([
            ["a", true],
            ["b", true],
            ["never", false],
          ])
          expect(
            field(
              (yield* get(`/live/actors?type=Inspected&ids=${encodeURIComponent('["a"]')}`, abroad))
                .body,
              "actors",
              0,
              "awake",
            ),
          ).toBe(false)

          yield* eventually(
            Effect.sync(
              () => watching.received.filter((m) => m.event === "command").length >= written,
            ),
            "the home stream to receive every committed command",
          )
          const streamed = watching.received.filter((m) => m.event === "command")
          expect(streamed.map((m) => text(field(m.data, "command"))).toSorted(byText)).toEqual(
            ["Sign", "Write", "Write", "Write", "WriteThenReject"].toSorted(byText),
          )
          expect(streamed.map((m) => text(field(m.data, "commandId"))).toSorted(byText)).toEqual(
            receipts.flatMap((row) => row.commandIds.split(",")).toSorted(byText),
          )
          expect(streamed.map((m) => m.id)).toEqual(streamed.map((m) => text(field(m.data, "id"))))
          const signed = streamed.find((m) => field(m.data, "command") === "Sign")!
          const preview = text(field(signed.data, "payloadPreview"))
          expect(preview).toContain('"password":"[redacted]"')
          expect(preview).not.toContain("hunter2")
          expect(preview).toContain('"profile":{"nick":"ada","secretAnswer":"[redacted]"}')
          expect(preview).not.toContain("blue-moon")
          expect(preview).toContain(`"note":"${"x".repeat(32)}…"`)
          expect(preview).toContain('"t8",…]')
          expect(preview.length <= 256).toBe(true)
          expect(field(signed.data, "callerKey", "json", 0)).toBe("User")
          const rejected = streamed.find((m) => field(m.data, "command") === "WriteThenReject")!
          expect([field(rejected.data, "outcomeTag"), field(rejected.data, "errorTag")]).toEqual([
            "Failure",
            "Rejected",
          ])
          expect(Number(field(rejected.data, "durationMs")) >= 0).toBe(true)

          yield* eventually(
            Effect.sync(() => failures.received.some((m) => m.event === "command")),
            "the failure stream to receive the declared failure",
          )
          expect(
            failures.received
              .filter((m) => m.event === "command")
              .map((m) => field(m.data, "command")),
          ).toEqual(["WriteThenReject"])
          yield* eventually(
            Effect.sync(() => foreign.received.some((m) => m.event === "command")),
            "the other tenant's stream to receive its own command",
          )
          expect(
            foreign.received
              .filter((m) => m.event === "command")
              .map((m) => field(m.data, "actorId")),
          ).toEqual(["c"])

          const lastId = streamed.at(-1)!.id!
          const resumed = yield* get.stream(`?after=${encodeURIComponent(lastId)}`, home)
          yield* b.Write("6")
          yield* eventually(
            Effect.sync(() => resumed.received.some((m) => m.event === "command")),
            "a resumed stream to receive the next command",
          )
          expect(
            resumed.received
              .filter((m) => m.event === "command")
              .map((m) => field(m.data, "payloadPreview")),
          ).toEqual(['"[redacted]"'])

          const stale = yield* get.stream("?after=elsewhere-1.3", home)
          yield* eventually(
            Effect.sync(() => stale.received.length > 0),
            "a stream resumed from another epoch to answer",
          )
          expect(stale.received.map((m) => m.event)).toEqual(["gap", "end"])

          const crossed = yield* get("/live/connections", abroad)
          expect(field(crossed.body, "sockets")).toBe(0)
        }).pipe(Effect.scoped),
      ),
  },
  {
    name: "inspector: lists declared schedules with the tenant's pending tick and last committed tick",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sql = yield* SqlClient.SqlClient
          const get = yield* serveInspector

          const declared = list((yield* get("/schedules", test.tenant)).body, "schedules").find(
            (row) => field(row, "actorType") === "InspectedSchedule",
          )
          expect(declared).toMatchObject({
            command: "Tick",
            pending: 0,
            nextDueAtMs: null,
            lastRun: null,
          })
          expect(text(field(declared ?? null, "key")).startsWith("$cron:")).toBe(true)
          expect(text(field(declared ?? null, "expression"))).toBe(
            text(field(declared ?? null, "key")).slice("$cron:".length),
          )

          yield* (yield* Scheduled.get("clock")).Nudge()
          yield* test.advance(0)

          const [pending] = yield* sql<{ due: number }>`
            SELECT due_at_ms::float8 AS due FROM actor_outbox
            WHERE tenant_id = ${test.tenant} AND actor_type = 'InspectedSchedule'
              AND timer_key LIKE '$cron:%'`
          const ticking = list((yield* get("/schedules", test.tenant)).body, "schedules").find(
            (row) => field(row, "actorType") === "InspectedSchedule",
          )
          expect(ticking).toMatchObject({ pending: 1, nextDueAtMs: pending!.due, lastRun: null })

          yield* test.advance("61 seconds")
          yield* eventually(
            sql<{ count: number }>`SELECT count(*)::int AS count FROM actor_receipts
              WHERE tenant_id = ${test.tenant} AND actor_type = 'InspectedSchedule'
                AND command = 'Tick'`.pipe(Effect.map((rows) => rows[0]!.count > 0)),
            "the cron tick to commit",
          )

          const [tick] = yield* sql<{
            command_id: string
            committed_at_ms: number
            duration: number
          }>`SELECT command_id, committed_at_ms::float8 AS committed_at_ms,
                (committed_at_ms - started_at_ms)::float8 AS duration
              FROM actor_receipts WHERE tenant_id = ${test.tenant}
                AND actor_type = 'InspectedSchedule' AND command = 'Tick'
              ORDER BY committed_at_ms DESC LIMIT 1`
          const fired = list((yield* get("/schedules", test.tenant)).body, "schedules").find(
            (row) => field(row, "actorType") === "InspectedSchedule",
          )
          expect(field(fired ?? null, "lastRun")).toEqual({
            commandId: tick!.command_id,
            committedAtMs: tick!.committed_at_ms,
            durationMs: tick!.duration,
            outcomeTag: "Success",
          })
          expect(
            field(
              list((yield* get("/schedules", `${test.tenant}-other`)).body, "schedules").find(
                (row) => field(row, "actorType") === "InspectedSchedule",
              ) ?? null,
              "pending",
            ),
          ).toBe(0)
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
            "/schedules",
            "/live/overview",
            "/live/activity?type=Inspected",
            "/live/latency?type=Inspected&window=7d",
            `/live/actors?type=Inspected&ids=${encodeURIComponent('["untouched"]')}`,
            "/live/connections",
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
