import {
  type CommandLogEntry,
  CommandFailed,
  CommandExpired as ExpiredKey,
  CommandStreamGap,
  CommandRefused,
  Conflict,
  ConnectionLimitExceeded,
  Forbidden,
  NotFound,
  NotImplemented,
  QuotaExceeded,
  QuotaUnbound,
  SpendLimitExceeded,
  StorageQuotaExceeded,
  RunnerDefect,
  Unavailable as CloudUnavailable,
} from "@akter/cloud-api"
import * as Framework from "@rikalabs/akter/client"
import { expect, it } from "@effect/vitest"
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Effect,
  Exit,
  Layer,
  Match,
  Redacted,
  Schema,
  Stream,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { type CommandAssignment, commandPayloadHash, Repository } from "./repository.ts"
import { makeRuntime, redactCause, RuntimeEdge } from "./runtime.ts"

interface Seen {
  readonly method: string
  readonly path: string
  readonly headers: Headers
  readonly body: string
}

type Answer = (request: Request) => Response

type Refusal =
  | CommandFailed
  | CommandRefused
  | Conflict
  | ConnectionLimitExceeded
  | Forbidden
  | NotFound
  | QuotaExceeded
  | QuotaUnbound
  | SpendLimitExceeded
  | StorageQuotaExceeded
  | CloudUnavailable
  | ExpiredKey
  | RunnerDefect

type Row = CommandAssignment
const expiresAt = Effect.runSync(Clock.currentTimeMillis) + 86_400_000
const mintedId = (index: number) =>
  `v1.1.${expiresAt}.00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
const assignment = (commandId: string, payload: Schema.Json): Row => ({
  commandId,
  payloadHash: commandPayloadHash(payload),
  expiresAt,
  expired: false,
})

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
const CommandExpired = Schema.TaggedStruct("CommandExpired", { commandId: Schema.String })
const MailboxFull = Schema.TaggedStruct("MailboxFull", {})

const ActorError = Schema.TaggedStruct("ActorError", {
  reason: Schema.Json,
  isRetryable: Schema.Boolean,
})

/** The envelope the edge serves a usage refusal in, with its `retry-after` in milliseconds. */
const ServedActorError = Schema.TaggedStruct("ActorError", {
  reason: Schema.Json,
  isRetryable: Schema.Boolean,
  retryAfter: Schema.Finite,
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
      input: Scope & {
        readonly payloadHash: string
        readonly mintedCommandId: string
        readonly expiresAt: number
      },
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
        const row: Row = {
          commandId: input.mintedCommandId,
          payloadHash: input.payloadHash,
          expiresAt: input.expiresAt,
          expired: false,
        }
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
          tenant: "default",
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
  onBehalfOf: "user:u-1",
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
    if (isMint(request)) return json({ commandId: mintedId(++minted) })
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
          commandId: mintedId(1),
          result: { cancelled: true },
          replayed: false,
        })
        expect(edge.seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
          "POST /command-ids",
          "POST /actors/Order/o%2F1/Cancel",
        ])

        const request = edge.seen[1]!

        expect(request.headers.get("idempotency-key")).toBe(mintedId(1))
        expect(request.headers.get("host")).toBe("orders.akter.test")
        expect(request.headers.get("authorization")).toBe(`Bearer ${SECRET}`)
        expect(request.headers.get("akter-on-behalf-of")).toBe("user:u-1")
        expect(edge.seen[0]!.headers.has("akter-on-behalf-of")).toBe(false)
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
          commandId: mintedId(1),
          result: { cancelled: true },
          replayed: false,
        })
        expect(edge.seen.map(({ path }) => path)).toEqual([
          "/command-ids",
          "/actors/Order/o%2F1/Cancel",
        ])
        expect(forwarded(edge.seen)[0]!.headers.get("idempotency-key")).toBe(mintedId(1))
        for (const { path, body, headers } of edge.seen) {
          expect(path).not.toContain(clientKey)
          expect(body).not.toContain(clientKey)
          for (const [, value] of headers) expect(value).not.toContain(clientKey)
        }
        expect(store.rows.get(key(scope(clientKey)))).toEqual(
          assignment(mintedId(1), { reason: "late" }),
        )
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
          commandId: mintedId(1),
          result: { cancelled: true },
          replayed: false,
        })

        yield* edge.answer(runner(() => json({ cancelled: "stored" }, 200, true)))

        expect(yield* runtime.sendCommand({ ...command, commandId: "client-retry" })).toEqual({
          commandId: mintedId(1),
          result: { cancelled: "stored" },
          replayed: true,
        })
        expect(edge.seen.map(({ path }) => path)).toEqual(["/actors/Order/o%2F1/Cancel"])
        expect(edge.seen[0]!.headers.get("idempotency-key")).toBe(mintedId(1))

        yield* edge.answer(runner(() => json({ cancelled: "again" })))

        expect(
          yield* runtime.sendCommand({
            ...command,
            address: "Order/o/2",
            commandId: "client-retry",
          }),
        ).toEqual({ commandId: mintedId(1), result: { cancelled: "again" }, replayed: false })
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
        ).toEqual({ commandId: mintedId(1), result: { cancelled: true }, replayed: true })
        expect(edge.seen.map(({ path }) => path)).toEqual(["/actors/Order/o%2F1/Cancel"])
        expect(edge.seen[0]!.headers.get("idempotency-key")).toBe(mintedId(1))

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

        yield* store.race(scope("client-race"), assignment("v1.winner", { reason: "late" }))
        yield* edge.answer(runner(() => json({ cancelled: true }, 200, true)))

        expect(yield* runtime.sendCommand({ ...command, commandId: "client-race" })).toEqual({
          commandId: "v1.winner",
          result: { cancelled: true },
          replayed: true,
        })
        expect(store.calls).toEqual(["find", `assign ${mintedId(1)}`])
        expect(forwarded(edge.seen).map(({ headers }) => headers.get("idempotency-key"))).toEqual([
          "v1.winner",
        ])

        yield* store.race(
          scope("client-race-mismatch"),
          assignment("v1.other", { reason: "other" }),
        )
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
          commandId: mintedId(1),
          result: null,
          replayed: false,
        })
        expect(edge.seen.map(({ path }) => path)).toEqual(["/actors/Order/o%2F1/Cancel"])
        expect(edge.seen[0]!.headers.get("idempotency-key")).toBe(mintedId(1))
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
            commandId: mintedId(1),
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
            commandId: mintedId(1),
            errorTag: "OutOfStock",
            error: OutOfStock.make({ sku: "s1" }),
            replayed: true,
          }),
        )
        expect(edge.seen.map(({ path }) => path)).toEqual(["/actors/Order/o%2F1/Cancel"])
        expect(edge.seen[0]!.headers.get("idempotency-key")).toBe(mintedId(1))

        const cases: ReadonlyArray<readonly [Response, (error: Refusal) => boolean]> = [
          [refused(NotCreated.make({}), 404), Schema.is(NotFound)],
          [
            refused(InvalidInput.make({ code: "unknown_route" }), 404),
            (error) => Schema.is(NotFound)(error) && error.resource === "command",
          ],
          [refused(CommandConflict.make({}), 409), Schema.is(Conflict)],
          [refused(Unauthorized.make({ code: "access_denied" }), 403), Schema.is(Forbidden)],
          [
            refused(Unauthorized.make({ code: "receipt_access_denied" }), 403),
            Schema.is(Forbidden),
          ],
          [
            refused(Unauthorized.make({ code: "invalid_credentials" }), 401),
            Schema.is(CloudUnavailable),
          ],
          [refused(Unauthorized.make({ code: "expired" }), 401), Schema.is(CloudUnavailable)],
          [
            refused(Unauthorized.make({ code: "reauthorization_unavailable" }), 403),
            Schema.is(CloudUnavailable),
          ],
          [refused(CommandExpired.make({ commandId: "v1.expired" }), 410), Schema.is(ExpiredKey)],
          [
            refused(InvalidCommandId.make({ commandId: "v1.bad", code: "malformed" }), 400),
            (error) =>
              Schema.is(CommandRefused)(error) &&
              error.reasonTag === "InvalidCommandId" &&
              Schema.is(Framework.InvalidCommandId)(error.reason) &&
              error.reason.code === "malformed",
          ],
          [
            refused(InvalidInput.make({ code: "decode" }), 400),
            (error) =>
              Schema.is(CommandRefused)(error) &&
              error.commandId === mintedId(1) &&
              error.reasonTag === "InvalidInput" &&
              Schema.is(Framework.InvalidInput)(error.reason) &&
              error.reason.code === "decode",
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
    "answers each edge usage refusal as its typed error with the framework's tag and payload, never a defect",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime
        const quota = {
          organizationId: "org1",
          period: "2026-10",
          limitUnits: 5_000_000,
          usedUnits: 4_999_998,
          requestedUnits: 5,
          unitsPerCommand: 5,
          retryAfterMs: 86_400_000,
        }
        const spend = {
          organizationId: "org1",
          period: "2026-10",
          limitCents: 1003,
          projectedCents: 1004,
        }
        const connections = { organizationId: "org1", kind: "sse" as const, limit: 3, open: 3 }
        const storage = {
          organizationId: "org1",
          deployment: "dep1",
          tenant: "acme",
          limitBytes: 500_000_000,
          usedBytes: 500_000_001,
        }
        const served = <S extends Schema.Top & { readonly Type: { readonly _tag: string } }>(
          schema: S,
          error: S["Type"],
          status: number,
        ) =>
          Schema.encodeEffect(Schema.toCodecJson(schema))(error).pipe(
            Effect.orDie,
            Effect.map((reason) =>
              json(
                ServedActorError.make({
                  reason: reason as Schema.Json,
                  isRetryable: false,
                  retryAfter: 86_400_000,
                }),
                status,
              ),
            ),
          )

        const cases = [
          [
            yield* served(Framework.QuotaExceeded, Framework.QuotaExceeded.make(quota), 429),
            QuotaExceeded.make(quota),
          ],
          [
            yield* served(
              Framework.SpendLimitExceeded,
              Framework.SpendLimitExceeded.make(spend),
              402,
            ),
            SpendLimitExceeded.make(spend),
          ],
          [
            yield* served(
              Framework.ConnectionLimitExceeded,
              Framework.ConnectionLimitExceeded.make(connections),
              429,
            ),
            ConnectionLimitExceeded.make(connections),
          ],
          [
            yield* served(
              Framework.StorageQuotaExceeded,
              Framework.StorageQuotaExceeded.make(storage),
              429,
            ),
            StorageQuotaExceeded.make(storage),
          ],
        ] as const

        for (const [index, [answer, expected]] of cases.entries()) {
          yield* edge.answer(runner(() => answer.clone()))

          const error = yield* runtime
            .sendCommand({ ...command, commandId: `client-usage-${index}` })
            .pipe(Effect.flip)

          expect(error).toBeInstanceOf(expected.constructor)
          expect(error).toEqual(expected)
        }
      }),
  )

  it.effect(
    "reports refused deployment credentials during minting as an outage, never a caller authentication error or defect",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime

        yield* edge.answer(() => refused(Unauthorized.make({ code: "invalid_credentials" }), 401))

        expect(yield* runtime.sendCommand(command).pipe(Effect.flip)).toEqual(
          CloudUnavailable.make({
            message: "The deployment could not authorize the request",
            retryAfterSeconds: 1,
          }),
        )
        expect(forwarded(edge.seen)).toEqual([])
      }),
  )

  it.effect(
    "keeps a full actor mailbox retryable instead of reporting a terminal admission refusal",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime

        yield* edge.answer(runner(() => refused(MailboxFull.make({}), 429)))

        expect(yield* runtime.sendCommand(command).pipe(Effect.flip)).toEqual(
          CloudUnavailable.make({
            message: "The actor mailbox is temporarily full",
            retryAfterSeconds: 1,
          }),
        )
      }),
  )

  it.effect("refuses a retained expired key before minting, payload comparison or delivery", () =>
    Effect.gen(function* () {
      const edge = yield* StandInEdge
      const store = yield* StandInStore
      const runtime = yield* makeRuntime
      store.rows.set(key(scope("expired-key")), {
        commandId: null,
        payloadHash: null,
        expiresAt: (yield* Clock.currentTimeMillis) - 1,
        expired: true,
      })
      yield* edge.answer(runner(() => json({ mustNotRun: true })))
      expect(
        yield* runtime
          .sendCommand({ ...command, commandId: "expired-key", payload: "different" })
          .pipe(Effect.flip),
      ).toEqual(ExpiredKey.make({ commandId: "expired-key" }))
      expect(edge.seen).toEqual([])
    }),
  )

  it.effect(
    "refuses an expiry that wins the assignment race without sending under the losing minted id",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const store = yield* StandInStore
        const runtime = yield* makeRuntime
        yield* store.race(scope("expired-race"), {
          commandId: null,
          payloadHash: null,
          expiresAt: (yield* Clock.currentTimeMillis) - 1,
          expired: true,
        })
        yield* edge.answer(runner(() => json({ mustNotRun: true })))
        expect(
          yield* runtime.sendCommand({ ...command, commandId: "expired-race" }).pipe(Effect.flip),
        ).toEqual(ExpiredKey.make({ commandId: "expired-race" }))
        expect(forwarded(edge.seen)).toEqual([])
      }),
  )

  it.effect(
    "answers the edge's 503 QuotaUnbound as a typed 402 refusal for each reason, while the edge's quota outage stays a reasonless Unavailable",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime

        for (const reason of ["tenant", "account", "plan"] as const) {
          const unbound = { deployment: "dep1", tenant: "acme", reason }
          const served = yield* Schema.encodeEffect(Schema.toCodecJson(QuotaUnbound))(
            QuotaUnbound.make(unbound),
          ).pipe(Effect.orDie)
          yield* edge.answer(runner(() => refused(served, 503)))

          const error = yield* runtime
            .sendCommand({ ...command, commandId: `client-unbound-${reason}` })
            .pipe(Effect.flip)

          expect(error).toBeInstanceOf(QuotaUnbound)
          expect(error).toEqual(QuotaUnbound.make(unbound))
        }

        yield* edge.answer(
          runner(() => refused(Schema.TaggedStruct("QuotaUnavailable", {}).make({}), 503)),
        )

        const outage = yield* runtime
          .sendCommand({ ...command, commandId: "client-quota-outage" })
          .pipe(Effect.flip)

        expect(outage).toBeInstanceOf(CloudUnavailable)
        expect(outage).not.toHaveProperty("reason")
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

  it.effect("returns an opaque non-retryable RunnerDefect after one runner attempt", () =>
    Effect.gen(function* () {
      const edge = yield* StandInEdge
      const runtime = yield* makeRuntime
      yield* edge.answer(
        runner(() =>
          json(
            { ...Defect.make({ traceId: "private-trace" }), message: "private-database-url" },
            500,
          ),
        ),
      )
      const failure = yield* runtime.sendCommand(command).pipe(Effect.flip)
      expect(failure).toEqual(RunnerDefect.make({}))
      expect(yield* Schema.encodeUnknownEffect(Schema.fromJsonString(RunnerDefect))(failure)).toBe(
        '{"_tag":"RunnerDefect"}',
      )
      expect(forwarded(edge.seen)).toHaveLength(1)
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

  it.effect(
    "inspects an actor from its inspector page and the serving runner's memory, reporting live fields only while that runner is the only one and null for the rest",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime
        const target = { organizationId: "org1", projectId: "p1", environment: "production" }
        const actor = {
          actorType: "Order",
          actorId: "o/1",
          placement: "tenant",
          generation: 3,
          created: true,
          lastEventSequence: 7,
        }
        const detail = {
          actor,
          state: [
            { key: "$version", bytes: 1, value: { json: 2 } },
            { key: "lines", bytes: 9, value: { json: [{ sku: "mug" }] } },
            { key: "total", bytes: 4, value: { json: 4200 } },
          ],
          receipts: [
            {
              commandId: "v1.c2",
              command: "Refund",
              callerKey: { json: ["User", "ada"] },
              outcomeTag: "Failure",
              outcome: { json: "the refund window closed" },
              expiresAtMs: 1_900_000_000_000,
              startedAtMs: 1_700_000_000_000,
              committedAtMs: 1_700_000_000_042,
              events: [],
            },
            {
              commandId: "v1.c1",
              command: "Place",
              callerKey: { json: ["User", "ada"] },
              outcomeTag: "Success",
              outcome: { json: "card ending 4242" },
              expiresAtMs: 1_800_000_000_000,
              startedAtMs: null,
              committedAtMs: null,
              events: [6, 7],
            },
          ],
          events: [
            {
              sequence: 7,
              event: "Charged",
              commandId: "v1.c1",
              value: null,
              bytes: 0,
              emittedAtMs: 2,
            },
            {
              sequence: 6,
              event: "Placed",
              commandId: "v1.c1",
              value: null,
              bytes: 0,
              emittedAtMs: 1,
            },
            {
              sequence: 4,
              event: "Charged",
              commandId: "v1.c0",
              value: null,
              bytes: 0,
              emittedAtMs: 0,
            },
          ],
          outbox: [],
          jobs: [
            {
              actorType: "Order",
              actorId: "o/1",
              jobId: "j1",
              job: "Email",
              payload: null,
              caller: null,
              attempts: 0,
              lastError: null,
              ambiguous: false,
              dueAtMs: 5,
            },
          ],
          deadLetters: [],
          workflows: [],
          totals: { receipts: 2, events: 3, outbox: 0, jobs: 1, deadLetters: 0, workflows: 0 },
        }

        const timeline: Schema.Json = {
          entries: [
            {
              kind: "event",
              sequence: 7,
              name: "Charged",
              commandId: "v1.c1",
              callerKey: { json: ["System", "timer", null, "user:u1"] },
              atMs: 2,
            },
            {
              kind: "command",
              sequence: 6,
              name: "Place",
              commandId: "v1.c1",
              callerKey: { json: ["Anonymous"] },
              atMs: 1,
            },
            {
              kind: "event",
              sequence: 4,
              name: "Charged",
              commandId: "v1.c0",
              callerKey: { undecodable: "not JSON" },
              atMs: 0,
            },
          ],
          next: { sequence: 4, kind: "event" },
        }

        const latest: Schema.Json = {
          events: [
            { event: "Charged", sequence: 7, emittedAtMs: 2 },
            { event: "Opened", sequence: 1, emittedAtMs: 0 },
            { event: "Placed", sequence: 6, emittedAtMs: 1 },
          ],
          next: null,
        }
        const live = (peers: number, awake: boolean): Schema.Json => ({
          scope: { runner: "runner-a", region: "us-east-1", startedAtMs: 1, peers },
          actors: [
            {
              actorId: "o/1",
              awake,
              mailbox: awake ? 3 : null,
              sockets: 2,
              feeds: [{ event: "Charged", subscribers: 5 }],
            },
          ],
        })
        const answering = (peers: number, awake: boolean) =>
          edge.answer((request) =>
            json(
              Match.value(new URL(request.url).pathname).pipe(
                Match.when("/inspector/timeline", () => timeline),
                Match.when("/inspector/latest-events", () => latest),
                Match.when("/inspector/live/actors", () => live(peers, awake)),
                Match.orElse(() => detail),
              ),
            ),
          )

        yield* answering(1, true)

        const inspected = yield* runtime.inspectActor({ ...target, address: "Order/o/1" })
        const ada = { kind: "user", subject: "ada", source: null }

        expect(inspected).toEqual({
          address: "Order/o/1",
          state: { lines: [{ sku: "mug" }], total: 4200 },
          turn: null,
          tables: null,
          receipts: [
            {
              commandId: "v1.c2",
              command: "Refund",
              result: "Failure",
              caller: ada,
              at: DateTime.makeUnsafe(1_700_000_000_042),
              expiresAt: DateTime.makeUnsafe(1_900_000_000_000),
              replayed: false,
            },
            {
              commandId: "v1.c1",
              command: "Place",
              result: "Success",
              caller: ada,
              at: null,
              expiresAt: DateTime.makeUnsafe(1_800_000_000_000),
              replayed: false,
            },
          ],
          events: [
            { name: "Charged", cursor: "7", emittedAt: DateTime.makeUnsafe(2), subscribers: null },
            { name: "Opened", cursor: "1", emittedAt: DateTime.makeUnsafe(0), subscribers: null },
            { name: "Placed", cursor: "6", emittedAt: DateTime.makeUnsafe(1), subscribers: null },
          ],
          jobs: [{ name: "Email", id: "j1", attempts: 0, status: "queued" }],
          connections: { sockets: null, feedCursor: "7" },
          properties: {
            status: null,
            type: "Order",
            generation: 3,
            runner: null,
            region: null,
            tenant: "default",
            mailboxDepth: null,
          },
          timeline: [
            {
              at: DateTime.makeUnsafe(2),
              kind: "event",
              label: "Charged",
              detail: "v1.c1",
              caller: { kind: "system", subject: "user:u1", source: "timer" },
            },
            {
              at: DateTime.makeUnsafe(1),
              kind: "command",
              label: "Place",
              detail: "v1.c1",
              caller: { kind: "anonymous", subject: null, source: null },
            },
            {
              at: DateTime.makeUnsafe(0),
              kind: "event",
              label: "Charged",
              detail: "v1.c0",
              caller: null,
            },
          ],
        })
        expect(edge.seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
          "GET /inspector/actor?type=Order&id=o%2F1&limit=500",
          "GET /inspector/latest-events?type=Order&id=o%2F1&limit=500",
          "GET /inspector/timeline?type=Order&id=o%2F1&limit=50",
          `GET /inspector/live/actors?type=Order&ids=${encodeURIComponent('["o/1"]')}`,
        ])
        expect(edge.seen[0]!.headers.get("authorization")).toBe(`Bearer ${SECRET}`)
        expect(edge.seen[0]!.headers.has("akter-on-behalf-of")).toBe(false)

        yield* answering(0, true)

        expect(yield* runtime.inspectActor({ ...target, address: "Order/o/1" })).toMatchObject({
          events: [
            { name: "Charged", subscribers: 5 },
            { name: "Opened", subscribers: 0 },
            { name: "Placed", subscribers: 0 },
          ],
          connections: { sockets: 2, feedCursor: "7" },
          properties: {
            status: "awake",
            runner: "runner-a",
            region: "us-east-1",
            mailboxDepth: 3,
          },
        })

        yield* answering(0, false)

        expect(yield* runtime.inspectActor({ ...target, address: "Order/o/1" })).toMatchObject({
          connections: { sockets: 2 },
          properties: { status: "idle", runner: null, region: null, mailboxDepth: 0 },
        })

        yield* edge.answer((request) =>
          json(
            Match.value(new URL(request.url).pathname).pipe(
              Match.when("/inspector/timeline", () => ({ entries: [], next: null })),
              Match.when("/inspector/latest-events", () => ({ events: [], next: null })),
              Match.when("/inspector/live/actors", () => live(2, true)),
              Match.orElse(() => ({
                ...detail,
                actor: { ...actor, lastEventSequence: 0 },
                state: [{ key: "total", bytes: 4, value: { undecodable: "not zstd" } }],
                receipts: [{ ...detail.receipts[0], callerKey: { json: ["Robot", "r2"] } }],
                events: [],
              })),
            ),
          ),
        )

        expect(yield* runtime.inspectActor({ ...target, address: "Order/o/1" })).toMatchObject({
          state: null,
          receipts: [{ commandId: "v1.c2", caller: null }],
          events: [],
          timeline: [],
          connections: { sockets: null, feedCursor: null },
        })

        yield* edge.answer(() => json(NotFoundBody.make({}), 404))

        expect(
          yield* runtime.inspectActor({ ...target, address: "Order/nope" }).pipe(Effect.flip),
        ).toEqual(NotFound.make({ resource: "actor", id: "Order/nope" }))
      }),
  )
})

it.layer(live)("command stream through the edge", (it) => {
  it.effect(
    "relays the runner's commands, resumes after the last id when a stream ends, and fails with CommandStreamGap at a gap rather than skip",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime
        const target = yield* (yield* RuntimeEdge).resolve({
          organizationId: "org1",
          projectId: "p1",
          environment: "production",
        })
        const sent = (seq: number, failed = false) => ({
          id: `e1.${seq}`,
          commandId: `v1.c${seq}`,
          atMs: 1_700_000_000_000 + seq,
          durationMs: seq,
          actorType: "Order",
          actorId: `o-${seq}`,
          command: failed ? "Refund" : "Place",
          callerKey: { json: ["User", "user:u-1"] },
          outcomeTag: failed ? "Failure" : "Success",
          errorTag: failed ? "TooLate" : null,
          payloadPreview: `{"n":${seq}}`,
        })
        const frame = (entry: ReturnType<typeof sent>) =>
          `event: command\nid: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`
        let opened = 0

        yield* edge.answer(() => {
          opened += 1
          const bodies = [
            `: open\n\n${frame(sent(1))}${frame(sent(2, true))}event: end\ndata: null\n\n`,
            `: open\n\n${frame(sent(3))}event: gap\ndata: null\n\nevent: end\ndata: null\n\n`,
          ]
          const body = bodies[opened - 1] ?? `: open\n\n${frame(sent(9))}`

          return new Response(body, { headers: { "content-type": "text/event-stream" } })
        })

        const relayed: Array<CommandLogEntry> = []
        const ended = yield* Stream.runForEach(
          runtime.commandStream(target, { type: "Order", outcome: undefined }),
          (entry) => Effect.sync(() => relayed.push(entry)),
        ).pipe(Effect.flip)

        expect(ended).toEqual(CommandStreamGap.make({}))

        expect(relayed.map((entry) => [entry.commandId, entry.outcome, entry.errorTag])).toEqual([
          ["v1.c1", "ok", null],
          ["v1.c2", "error", "TooLate"],
          ["v1.c3", "ok", null],
        ])
        expect(relayed[0]).toEqual({
          commandId: "v1.c1",
          at: DateTime.makeUnsafe(1_700_000_000_001),
          durationMs: 1,
          address: "Order/o-1",
          command: "Place",
          caller: { kind: "user", subject: "user:u-1", source: null },
          payloadPreview: '{"n":1}',
          outcome: "ok",
          errorTag: null,
        })
        expect(edge.seen.map(({ path }) => path)).toEqual([
          "/inspector/commands/stream?type=Order",
          "/inspector/commands/stream?type=Order&after=e1.2",
        ])
        expect(
          edge.seen.every(({ headers }) => headers.get("authorization") === `Bearer ${SECRET}`),
        ).toBe(true)
      }),
  )
})

it.layer(live)("live reads through the edge", (it) => {
  it.effect(
    "answers a wholly live read only while the cluster lists no runner but the one that answered",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime
        const target = yield* (yield* RuntimeEdge).resolve({
          organizationId: "org1",
          projectId: "p1",
          environment: "production",
        })
        const connections = (peers: number | null) => ({
          scope: { runner: "r1", region: "us-east-1", startedAtMs: 1, peers },
          sockets: 1,
          feeds: 2,
          streams: 0,
          watches: 0,
          byActorType: [],
        })
        const read = (peers: number | null) =>
          edge
            .answer(() => json(connections(peers)))
            .pipe(
              Effect.andThen(
                runtime.liveRead(
                  target,
                  "/live/connections",
                  {},
                  Framework.Inspection.LiveConnections,
                  "runtime.getConnections",
                ),
              ),
              Effect.exit,
            )

        expect(yield* read(0)).toEqual(Exit.succeed(connections(0)))
        expect(yield* read(1)).toEqual(
          Exit.fail(NotImplemented.make({ operation: "runtime.getConnections" })),
        )
        expect(yield* read(null)).toEqual(
          Exit.fail(NotImplemented.make({ operation: "runtime.getConnections" })),
        )
        expect(edge.seen.map(({ path }) => path)).toEqual(["/inspector/live/connections"])

        yield* edge.answer(() =>
          json({
            scope: { runner: "r1", region: "us-east-1", startedAtMs: 1, peers: 1 },
            actors: [{ actorId: "o-1", awake: true, mailbox: 2, sockets: 1, feeds: [] }],
          }),
        )
        expect(yield* runtime.liveActors(target, "Order", ["o-1"])).toBeUndefined()
      }),
  )
})

it("redacts a stored cause to its error's tag and message, without stack frames or file paths", () => {
  const frame =
    "\n    at /workspace/node_modules/.bun/effect@4.0.0/node_modules/effect/dist/Schema.js:8958:81"
  const redacted = [
    redactCause(`Unsettled: ${frame}${frame}`),
    redactCause(`Error: card declined at /workspace/app/src/billing.ts:12:4${frame}`),
    redactCause("Order/o-1 refused: insufficient funds"),
    redactCause("\n\nSucceeded after it was cancelled"),
  ]

  expect(redacted).toEqual([
    "Unsettled",
    "Error: card declined",
    "Order/o-1 refused: insufficient funds",
    "Succeeded after it was cancelled",
  ])
  for (const text of redacted)
    expect(text).not.toMatch(/\bat\s|node_modules|\.[jt]s:\d|\/workspace/u)
})
