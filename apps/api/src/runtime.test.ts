import {
  CommandFailed,
  Conflict,
  Forbidden,
  NotFound,
  Unavailable as CloudUnavailable,
} from "@akter/cloud-api"
import { expect, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { makeRuntime, RuntimeEdge } from "./runtime.ts"

interface Seen {
  readonly method: string
  readonly path: string
  readonly headers: Headers
  readonly body: string
}

type Answer = (request: Request) => Response

type Refusal = CommandFailed | Conflict | Forbidden | NotFound | CloudUnavailable

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
).pipe(Layer.provideMerge(standIn), Layer.provideMerge(FetchHttpClient.layer))

const command = {
  organizationId: "org1",
  projectId: "p1",
  environment: "production",
  address: "Order/o/1",
  command: "Cancel",
  payload: { reason: "late" },
} as const

const inspectorPath = (request: Request) => new URL(request.url).pathname.startsWith("/inspector/")

const inspector =
  (found: Response, otherwise: Response): Answer =>
  (request) =>
    inspectorPath(request) ? found.clone() : otherwise.clone()

it.layer(live)("runtime forwarding through the edge", (it) => {
  it.effect(
    "mints a command id, posts under the deployment host with only the service credential, and reports a new id as not replayed",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime

        yield* edge.answer((request) =>
          new URL(request.url).pathname === "/command-ids"
            ? json({ commandId: "v1.minted" })
            : json({ cancelled: true }),
        )

        const sent = yield* runtime.sendCommand(command)

        expect(sent).toEqual({
          commandId: "v1.minted",
          result: { cancelled: true },
          replayed: false,
        })
        expect(edge.seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
          "POST /command-ids",
          "POST /actors/Order/o%2F1/Cancel",
        ])

        const request = edge.seen[1]!

        expect(request.headers.get("idempotency-key")).toBe("v1.minted")
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
    "resends a caller's command id unchanged and reports the runner's authoritative replay marker without inspecting receipts",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime

        for (const replayed of [true, false]) {
          yield* edge.answer(() => json(null, 200, replayed))

          const sent = yield* runtime.sendCommand({ ...command, commandId: "v1.mine" })

          expect(sent).toEqual({ commandId: "v1.mine", result: null, replayed })
          expect(edge.seen.map(({ path }) => path)).toEqual(["/actors/Order/o%2F1/Cancel"])
          expect(edge.seen.at(-1)!.headers.get("idempotency-key")).toBe("v1.mine")
          expect(edge.seen.some(({ path }) => path === "/command-ids")).toBe(false)
        }
      }),
  )

  it.effect(
    "refuses a successful response without authoritative replay metadata instead of guessing",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime
        yield* edge.answer(
          () =>
            new Response("null", { status: 200, headers: { "content-type": "application/json" } }),
        )
        const result = yield* runtime
          .sendCommand({ ...command, commandId: "v1.unknown" })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(true)
      }),
  )

  it.effect(
    "answers an actor's declared error as CommandFailed and maps the framework's refusals",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime
        const notFound = json(NotFoundBody.make({}), 404)

        const declared = (error: Refusal) =>
          Schema.is(CommandFailed)(error) &&
          error.errorTag === "OutOfStock" &&
          error.commandId === "v1.c" &&
          !error.replayed &&
          Schema.is(OutOfStock)(error.error)

        const cases: ReadonlyArray<readonly [Response, (error: Refusal) => boolean]> = [
          [json(OutOfStock.make({ sku: "s1" }), 422), declared],
          [refused(NotCreated.make({}), 404), Schema.is(NotFound)],
          [
            refused(InvalidInput.make({ code: "unknown_route" }), 404),
            (error) => Schema.is(NotFound)(error) && error.resource === "command",
          ],
          [refused(CommandConflict.make({}), 409), Schema.is(Conflict)],
          [refused(Unauthorized.make({ code: "access_denied" }), 403), Schema.is(Forbidden)],
          [
            refused(InvalidInput.make({ code: "decode" }), 400),
            (error) => Schema.is(CommandFailed)(error) && error.errorTag === "InvalidInput",
          ],
        ]

        for (const [answer, expected] of cases) {
          yield* edge.answer(inspector(notFound, answer))

          const error = yield* runtime
            .sendCommand({ ...command, commandId: "v1.c" })
            .pipe(Effect.flip)

          expect(expected(error)).toBe(true)
        }
      }),
  )

  it.effect(
    "maps temporary edge outages to 503 while keeping a refused service credential or remote defect opaque",
    () =>
      Effect.gen(function* () {
        const edge = yield* StandInEdge
        const runtime = yield* makeRuntime
        const notFound = json(NotFoundBody.make({}), 404)

        for (const answer of [
          refused(Unavailable.make({}), 503),
          new Response("<html>bad gateway</html>", { status: 502 }),
        ]) {
          yield* edge.answer(inspector(notFound, answer))
          expect(
            yield* runtime.sendCommand({ ...command, commandId: "v1.c" }).pipe(Effect.flip),
          ).toEqual(
            CloudUnavailable.make({
              message: "The deployment is temporarily unavailable",
              retryAfterSeconds: 1,
            }),
          )
        }
        for (const answer of [
          refused(Unauthorized.make({ code: "invalid_credentials" }), 401),
          json(Defect.make({ traceId: "t" }), 500),
        ]) {
          yield* edge.answer(inspector(notFound, answer))

          const exit = yield* Effect.exit(runtime.sendCommand({ ...command, commandId: "v1.c" }))

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
