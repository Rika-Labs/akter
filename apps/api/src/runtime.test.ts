import {
  CommandFailed,
  CommandRefused,
  Conflict,
  Forbidden,
  NotFound,
  Unavailable as CloudUnavailable,
} from "@akter/cloud-api"
import { expect, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { Repository } from "./repository.ts"
import { makeRuntime, RuntimeEdge } from "./runtime.ts"

interface Seen {
  readonly method: string
  readonly path: string
  readonly headers: Headers
  readonly body: string
}

type Answer = (request: Request) => Response

type Refusal = CommandFailed | CommandRefused | Conflict | Forbidden | NotFound | CloudUnavailable

interface Row {
  readonly commandId: string
  readonly payload: Schema.Json
}

interface Scope {
  readonly organizationId: string
  readonly projectId: string
  readonly environment: string
  readonly address: string
  readonly command: string
  readonly commandId: string
}

const SECRET = "dak_service_credential"

const json = (body: Schema.Json, status = 200, replayed = false) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "durable-replayed": String(replayed) },
  })

const NotFoundBody = Schema.TaggedStruct("NotFound", {})
const OutOfStock = Schema.TaggedStruct("OutOfStock", { sku: Schema.String })
const Defect = Schema.TaggedStruct("Defect", { traceId: Schema.String })

const NotCreated = Schema.TaggedStruct("NotCreated", {})
const CommandConflict = Schema.TaggedStruct("CommandConflict", {})
const Unavailable = Schema.TaggedStruct("ActorUnavailable", {})
const Unauthorized = Schema.TaggedStruct("Unauthorized", { code: Schema.String })
const InvalidInput = Schema.TaggedStruct("InvalidInput", { code: Schema.String })
const InvalidCommandId = Schema.TaggedStruct("InvalidCommandId", {
  commandId: Schema.String,
  code: Schema.String,
})

const ActorError = Schema.TaggedStruct("ActorError", {
  reason: Schema.Json,
  isRetryable: Schema.Boolean,
})

const refused = (reason: Schema.Json, status: number) =>
  json(ActorError.make({ reason, isRetryable: false }), status)

/** A stand-in edge: it records each request and answers it with the test's current `answer`. */
class StandInEdge extends Context.Service<
  StandInEdge,
  {
    readonly origin: string
    readonly seen: Array<Seen>
    readonly answer: (answer: Answer) => Effect.Effect<void>
  }
>()("@akter/api/runtime.test/StandInEdge") {}

/**
 * A stand-in for the control plane's command rows. `assignCommand` keeps the
 * first row for a scope like the durable insert does, and `race` plants a row
 * that a concurrent request committed after this request's lookup.
 */
class StandInStore extends Context.Service<
  StandInStore,
  {
    readonly rows: Map<string, Row>
    readonly calls: Array<string>
    readonly race: (scope: Scope, row: Row) => Effect.Effect<void>
  }
>()("@akter/api/runtime.test/StandInStore") {}

const key = (scope: Scope) =>
  JSON.stringify([
    scope.organizationId,
    scope.projectId,
    scope.environment,
    scope.address,
    scope.command,
    scope.commandId,
  ])

const standIn = Layer.effect(
  StandInEdge,
  Effect.gen(function* () {
    const seen: Array<Seen> = []
    let answer: Answer = () => json(null)

    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch: (request) =>
            request.text().then((body) => {
              const url = new URL(request.url)

              seen.push({
                method: request.method,
                path: `${url.pathname}${url.search}`,
                headers: request.headers,
                body,
              })

              return answer(request)
            }),
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )

    return {
      origin: `http://127.0.0.1:${server.port}`,
      seen,
      answer: (next: Answer) =>
        Effect.sync(() => {
          seen.length = 0
          answer = next
        }),
    }
  }),
)

const store = Layer.sync(StandInStore, () => {
  const rows = new Map<string, Row>()
  const calls: Array<string> = []

  return {
    rows,
    calls,
    race: (scope: Scope, row: Row) =>
      Effect.sync(() => {
        calls.length = 0
        rows.set(`race:${key(scope)}`, row)
      }),
  }
})

const repository = Layer.effect(
  Repository,
  Effect.map(StandInStore, ({ rows, calls }) => {
    const findCommand = (input: Scope) =>
      Effect.sync(() => {
        calls.push("find")
        return rows.get(key(input))
      })

    const assignCommand = (
      input: Scope & { readonly payload: Schema.Json; readonly mintedCommandId: string },
    ) =>
      Effect.sync(() => {
        calls.push(`assign ${input.mintedCommandId}`)
        const raced = rows.get(`race:${key(input)}`)
        if (raced !== undefined) {
          rows.delete(`race:${key(input)}`)
          rows.set(key(input), raced)
        }
        const existing = rows.get(key(input))
        if (existing !== undefined) return existing
        const row: Row = { commandId: input.mintedCommandId, payload: input.payload }
        rows.set(key(input), row)
        return row
      })

    return { findCommand, assignCommand } as Repository["Service"]
  }),
).pipe(Layer.provideMerge(store))

const live = Layer.effect(
  RuntimeEdge,
  Effect.map(StandInEdge, ({ origin }) =>
    RuntimeEdge.of({
      resolve: () =>
        Effect.succeed({
          origin,
          host: "orders.akter.test",
          credential: Redacted.make(SECRET),
        }),
    }),
  ),
).pipe(
  Layer.provideMerge(standIn),
  Layer.provideMerge(repository),
  Layer.provideMerge(FetchHttpClient.layer),
)

const command = {
  organizationId: "org1",
  projectId: "p1",
  environment: "production",
  address: "Order/o/1",
  command: "Cancel",
  payload: { reason: "late" },
} as const

const scope = (commandId: string): Scope => ({
  organizationId: command.organizationId,
  projectId: command.projectId,
  environment: command.environment,
  address: command.address,
  command: command.command,
  commandId,
})

const inspectorPath = (request: Request) => new URL(request.url).pathname.startsWith("/inspector/")

const isMint = (request: Request) => new URL(request.url).pathname === "/command-ids"

/**
 * A runner that mints `v1.minted.1`, `v1.minted.2`, ... at `/command-ids`,
 * answers any inspector read with a 404 so a send cannot depend on one, and
 * answers everything else with `otherwise`.
 */
const runner = (otherwise: Answer): Answer => {
  let minted = 0

  return (request) => {
    if (isMint(request)) return json({ commandId: `v1.minted.${++minted}` })
    if (inspectorPath(request)) return json(NotFoundBody.make({}), 404)
    return otherwise(request)
  }
}

const forwarded = (seen: ReadonlyArray<Seen>) =>
  seen.filter(({ path }) => path.startsWith("/actors/"))

it.layer(live)("runtime forwarding through the edge", (it) => {
  it.effect(
    "mints a command id, posts under the deployment host with only the service credential, and reports a new id as not replayed",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime

        yield* edge.answer(runner(() => json({ cancelled: true })))

        const sent = yield* runtime.sendCommand(command)

        expect(sent).toEqual({
          commandId: "v1.minted.1",
          result: { cancelled: true },
          replayed: false,
        })
        expect(edge.seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
          "POST /command-ids",
          "POST /actors/Order/o%2F1/Cancel",
        ])

        const request = edge.seen[1]!

        expect(request.headers.get("idempotency-key")).toBe("v1.minted.1")
        expect(request.headers.get("host")).toBe("orders.akter.test")
        expect(request.headers.get("authorization")).toBe(`Bearer ${SECRET}`)
        expect(request.headers.get("content-type")).toContain("application/json")
        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(request.body),
        ).toEqual({ reason: "late" })
        for (const name of ["cookie", "x-api-key"]) expect(request.headers.has(name)).toBe(false)
      }),
  )

  it.effect(
    "never forwards a client's key: an arbitrary UUID is looked up, a runner id is minted and durably assigned, and only that id reaches the runner",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const store = yield* StandInStore
        const runtime = yield* makeRuntime
        const clientKey = "3f2b8c1e-7d4a-4e9b-a6c5-0b1d2e3f4a5b"

        yield* edge.answer(runner(() => json({ cancelled: true })))

        const sent = yield* runtime.sendCommand({ ...command, commandId: clientKey })

        expect(sent).toEqual({
          commandId: "v1.minted.1",
          result: { cancelled: true },
          replayed: false,
        })
        expect(edge.seen.map(({ path }) => path)).toEqual([
          "/command-ids",
          "/actors/Order/o%2F1/Cancel",
        ])
        expect(forwarded(edge.seen)[0]!.headers.get("idempotency-key")).toBe("v1.minted.1")
        for (const { path, body, headers } of edge.seen) {
          expect(path).not.toContain(clientKey)
          expect(body).not.toContain(clientKey)
          for (const [, value] of headers) expect(value).not.toContain(clientKey)
        }
        expect(store.rows.get(key(scope(clientKey)))).toEqual({
          commandId: "v1.minted.1",
          payload: { reason: "late" },
        })
      }),
  )

  it.effect(
    "resends a retry of the same client key under its assigned id without minting, reports the runner's replay marker, and keys rows by the whole command scope",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime

        yield* edge.answer(runner(() => json({ cancelled: true })))

        expect(yield* runtime.sendCommand({ ...command, commandId: "client-retry" })).toEqual({
          commandId: "v1.minted.1",
          result: { cancelled: true },
          replayed: false,
        })

        yield* edge.answer(runner(() => json({ cancelled: "stored" }, 200, true)))

        expect(yield* runtime.sendCommand({ ...command, commandId: "client-retry" })).toEqual({
          commandId: "v1.minted.1",
          result: { cancelled: "stored" },
          replayed: true,
        })
        expect(edge.seen.map(({ path }) => path)).toEqual(["/actors/Order/o%2F1/Cancel"])
        expect(edge.seen[0]!.headers.get("idempotency-key")).toBe("v1.minted.1")

        yield* edge.answer(runner(() => json({ cancelled: "again" })))

        expect(
          yield* runtime.sendCommand({
            ...command,
            address: "Order/o/2",
            commandId: "client-retry",
          }),
        ).toEqual({ commandId: "v1.minted.1", result: { cancelled: "again" }, replayed: false })
        expect(edge.seen.map(({ path }) => path)).toEqual([
          "/command-ids",
          "/actors/Order/o%2F2/Cancel",
        ])
      }),
  )

  it.effect(
    "treats a retry whose payload only reorders keys as the same command and refuses a different payload under the same key as a Conflict",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime
        const payload = { reason: "late", detail: { by: "ops", at: 3 } }

        yield* edge.answer(runner(() => json({ cancelled: true })))

        yield* runtime.sendCommand({ ...command, payload, commandId: "client-payload" })

        yield* edge.answer(runner(() => json({ cancelled: true }, 200, true)))

        expect(
          yield* runtime.sendCommand({
            ...command,
            payload: { detail: { at: 3, by: "ops" }, reason: "late" },
            commandId: "client-payload",
          }),
        ).toEqual({ commandId: "v1.minted.1", result: { cancelled: true }, replayed: true })
        expect(edge.seen.map(({ path }) => path)).toEqual(["/actors/Order/o%2F1/Cancel"])
        expect(edge.seen[0]!.headers.get("idempotency-key")).toBe("v1.minted.1")

        yield* edge.answer(runner(() => json({ cancelled: "again" })))

        for (const different of [
          { reason: "early", detail: { by: "ops", at: 3 } },
          { reason: "late", detail: { by: "ops", at: 4 } },
          { reason: "late" },
        ] as ReadonlyArray<Schema.Json>) {
          const error = yield* runtime
            .sendCommand({ ...command, payload: different, commandId: "client-payload" })
            .pipe(Effect.flip)

          expect(Schema.is(Conflict)(error)).toBe(true)
        }
        expect(edge.seen).toEqual([])
      }),
  )

  it.effect(
    "forwards the durably assigned winner when a concurrent send claimed the key after this one's lookup",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const store = yield* StandInStore
        const runtime = yield* makeRuntime

        yield* store.race(scope("client-race"), {
          commandId: "v1.winner",
          payload: { reason: "late" },
        })
        yield* edge.answer(runner(() => json({ cancelled: true }, 200, true)))

        expect(yield* runtime.sendCommand({ ...command, commandId: "client-race" })).toEqual({
          commandId: "v1.winner",
          result: { cancelled: true },
          replayed: true,
        })
        expect(store.calls).toEqual(["find", "assign v1.minted.1"])
        expect(forwarded(edge.seen).map(({ headers }) => headers.get("idempotency-key"))).toEqual([
          "v1.winner",
        ])

        yield* store.race(scope("client-race-mismatch"), {
          commandId: "v1.other",
          payload: { reason: "other" },
        })
        yield* edge.answer(runner(() => json({ cancelled: true })))

        const error = yield* runtime
          .sendCommand({ ...command, commandId: "client-race-mismatch" })
          .pipe(Effect.flip)

        expect(Schema.is(Conflict)(error)).toBe(true)
        expect(forwarded(edge.seen)).toEqual([])
      }),
  )

  it.effect(
    "retries a send that hit an outage under the same assigned id without minting again",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime

        yield* edge.answer(runner(() => refused(Unavailable.make({}), 503)))

        expect(
          Schema.is(CloudUnavailable)(
            yield* runtime
              .sendCommand({ ...command, commandId: "client-unfinished" })
              .pipe(Effect.flip),
          ),
        ).toBe(true)

        yield* edge.answer(runner(() => json(null, 200, false)))

        expect(yield* runtime.sendCommand({ ...command, commandId: "client-unfinished" })).toEqual({
          commandId: "v1.minted.1",
          result: null,
          replayed: false,
        })
        expect(edge.seen.map(({ path }) => path)).toEqual(["/actors/Order/o%2F1/Cancel"])
        expect(edge.seen[0]!.headers.get("idempotency-key")).toBe("v1.minted.1")
      }),
  )

  it.effect(
    "refuses a successful response without authoritative replay metadata instead of guessing",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime
        yield* edge.answer(
          runner(
            () =>
              new Response("null", {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
          ),
        )
        const result = yield* runtime
          .sendCommand({ ...command, commandId: "client-unknown" })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(true)
      }),
  )

  it.effect(
    "answers an actor's declared error as CommandFailed under the assigned id, trusts the runner's replay marker on retry, and maps the framework's refusals",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime

        yield* edge.answer(runner(() => json(OutOfStock.make({ sku: "s1" }), 422)))

        const declared = yield* runtime
          .sendCommand({ ...command, commandId: "client-declared" })
          .pipe(Effect.flip)

        expect(declared).toEqual(
          CommandFailed.make({
            commandId: "v1.minted.1",
            errorTag: "OutOfStock",
            error: OutOfStock.make({ sku: "s1" }),
            replayed: false,
          }),
        )

        yield* edge.answer(runner(() => json(OutOfStock.make({ sku: "s1" }), 422, true)))

        expect(
          yield* runtime
            .sendCommand({ ...command, commandId: "client-declared" })
            .pipe(Effect.flip),
        ).toEqual(
          CommandFailed.make({
            commandId: "v1.minted.1",
            errorTag: "OutOfStock",
            error: OutOfStock.make({ sku: "s1" }),
            replayed: true,
          }),
        )
        expect(edge.seen.map(({ path }) => path)).toEqual(["/actors/Order/o%2F1/Cancel"])
        expect(edge.seen[0]!.headers.get("idempotency-key")).toBe("v1.minted.1")

        const cases: ReadonlyArray<readonly [Response, (error: Refusal) => boolean]> = [
          [refused(NotCreated.make({}), 404), Schema.is(NotFound)],
          [
            refused(InvalidInput.make({ code: "unknown_route" }), 404),
            (error) => Schema.is(NotFound)(error) && error.resource === "command",
          ],
          [refused(CommandConflict.make({}), 409), Schema.is(Conflict)],
          [refused(Unauthorized.make({ code: "access_denied" }), 403), Schema.is(Forbidden)],
          [refused(Unauthorized.make({ code: "invalid_credentials" }), 401), Schema.is(Forbidden)],
          [
            refused(InvalidCommandId.make({ commandId: "v1.bad", code: "malformed" }), 400),
            (error) => Schema.is(CommandRefused)(error) && error.reasonTag === "InvalidCommandId",
          ],
          [
            refused(InvalidInput.make({ code: "decode" }), 400),
            (error) =>
              Schema.is(CommandRefused)(error) &&
              error.commandId === "v1.minted.1" &&
              error.reasonTag === "InvalidInput",
          ],
        ]

        for (const [index, [answer, expected]] of cases.entries()) {
          yield* edge.answer(runner(() => answer.clone()))

          const error = yield* runtime
            .sendCommand({ ...command, commandId: `client-refusal-${index}` })
            .pipe(Effect.flip)

          expect(expected(error)).toBe(true)
        }
      }),
  )

  it.effect(
    "maps temporary edge outages to 503 while keeping a remote defect or unknown refusal opaque",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime

        for (const [index, answer] of [
          refused(Unavailable.make({}), 503),
          new Response("<html>bad gateway</html>", { status: 502 }),
        ].entries()) {
          yield* edge.answer(runner(() => answer.clone()))
          expect(
            yield* runtime
              .sendCommand({ ...command, commandId: `client-outage-${index}` })
              .pipe(Effect.flip),
          ).toEqual(
            CloudUnavailable.make({
              message: "The deployment is temporarily unavailable",
              retryAfterSeconds: 1,
            }),
          )
        }
        for (const [index, answer] of [
          json(Defect.make({ traceId: "t" }), 500),
          refused(Schema.TaggedStruct("Novel", {}).make({}), 500),
        ].entries()) {
          yield* edge.answer(runner(() => answer.clone()))

          const exit = yield* Effect.exit(
            runtime.sendCommand({ ...command, commandId: `client-defect-${index}` }),
          )

          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        }
      }),
  )

  it.effect(
    "lists an actor's jobs from its inspector page, with dead letters as dead, and 404s an unknown actor",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime
        const target = { organizationId: "org1", projectId: "p1", environment: "production" }

        yield* edge.answer(() =>
          json({
            jobs: [
              { job: "Email", jobId: "j1", attempts: 0 },
              { job: "Email", jobId: "j2", attempts: 3 },
            ],
            deadLetters: [{ job: "Sync", jobId: "j3", attempts: 8 }],
          }),
        )

        expect(yield* runtime.actorJobs({ ...target, address: "Order/o1" })).toEqual([
          { name: "Email", id: "j1", attempts: 0, status: "queued" },
          { name: "Email", id: "j2", attempts: 3, status: "retrying" },
          { name: "Sync", id: "j3", attempts: 8, status: "dead" },
        ])
        expect(edge.seen[0]!.headers.get("host")).toBe("orders.akter.test")
        expect(edge.seen[0]!.headers.get("authorization")).toBe(`Bearer ${SECRET}`)

        yield* edge.answer(() => json(NotFoundBody.make({}), 404))

        const missing = yield* runtime
          .actorJobs({ ...target, address: "Order/nope" })
          .pipe(Effect.flip)

        expect(Schema.is(NotFound)(missing)).toBe(true)
      }),
  )
})
