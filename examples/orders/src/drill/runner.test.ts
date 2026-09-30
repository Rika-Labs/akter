import { createServer } from "node:net"
import { BunHttpServer, BunServices } from "@effect/platform-bun"
import {
  Clock,
  Config,
  Console,
  Context,
  type Duration,
  Effect,
  Exit,
  Fiber,
  identity,
  Layer,
  ManagedRuntime,
  Match,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Pool } from "pg"
import { disposableDatabase } from "@durable-actors/core/testing"
import { afterAll, describe, expect, it } from "vitest"
import { fakeLedger } from "../payments/ledger.ts"

/**
 * Every fault point an order passes through, each named with the command or
 * effect it stops at. The first three stop `Place` itself, so the client
 * never gets its reply; the rest stop the relay or the executor after the
 * order was acknowledged.
 */
const FAULTS = [
  { fault: "beforeHandler:Place", acknowledged: false },
  { fault: "beforeCommit:Place", acknowledged: false },
  { fault: "afterCommit:Place", acknowledged: false },
  { fault: "afterClaim:Open", acknowledged: true },
  { fault: "beforeOutboxDelete:Open", acknowledged: true },
  { fault: "beforeExecute:Charge", acknowledged: true },
  { fault: "afterExecute:Charge", acknowledged: true },
  { fault: "afterClaim:Charged", acknowledged: true },
  { fault: "beforeOutboxDelete:Charged", acknowledged: true },
] as const

const ORDER = {
  items: [
    { sku: "kettle", quantity: 1 },
    { sku: "mug", quantity: 2 },
    { sku: "tea", quantity: 1 },
  ],
}

const TOTAL = 3900 + 2 * 1200 + 850

const isBound = Schema.is(Schema.Struct({ port: Schema.Int }))

/** A port the OS just handed out, so each process can listen on its own. */
const freePort = Effect.callback<number>((resume) => {
  const server = createServer()
  server.once("error", (error) => resume(Effect.die(error)))
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    server.close(() =>
      resume(
        isBound(address)
          ? Effect.succeed(address.port)
          : Effect.die(new Error("the probe socket has no port")),
      ),
    )
  })
})

const Placed = Schema.Struct({
  orderId: Schema.String,
  total: Schema.Int,
  shipments: Schema.Array(Schema.String),
})

const Summary = Schema.Struct({ status: Schema.String, chargeId: Schema.optional(Schema.String) })

const Tracking = Schema.Struct({ status: Schema.String })

const until = <A, E, R>(
  check: Effect.Effect<A | undefined, E, R>,
  what: string,
  within: Duration.Input,
) =>
  Effect.gen(function* () {
    for (;;) {
      const value = yield* check

      if (value !== undefined) return value

      yield* Effect.sleep("100 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: within,
      orElse: () => Effect.die(new Error(`timed out waiting for ${what}`)),
    }),
  )

/**
 * Killing a process needs separate processes and a real database, so the drill
 * runs on Postgres only.
 */
const runtime = ManagedRuntime.make(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))

afterAll(() => runtime.dispose())

const pglite = runtime.runSync(Config.String("TEST_BACKEND")) === "pglite"

describe.skipIf(pglite)("orders crash drill with Postgres", () => {
  for (const { fault, acknowledged } of FAULTS)
    it(
      `loses no order and charges once when the runner is SIGKILLed at ${fault}`,
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const database = new URL(
              Redacted.value(
                yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") }),
              ),
            )

            const pool = yield* Effect.acquireRelease(
              Effect.sync(() => new Pool({ connectionString: database.href })),
              (db) => Effect.promise(() => db.end()),
            )

            const count = (text: string, values: ReadonlyArray<string> = []) =>
              Effect.promise(() => pool.query(text, [...values])).pipe(
                Effect.map((result) => Number(result.rows[0].count)),
              )

            const ledger = fakeLedger()

            const provider = yield* Layer.build(
              HttpRouter.serve(ledger.routes, { disableLogger: true, disableListenLog: true }).pipe(
                Layer.provideMerge(BunHttpServer.layer({ port: 0, hostname: "127.0.0.1" })),
              ),
            )

            const providerUrl = Match.value(
              Context.get(provider, HttpServer.HttpServer).address,
            ).pipe(
              Match.tag("InetAddressV4", ({ port }) => `http://127.0.0.1:${port}`),
              Match.orElse(() => ""),
            )

            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

            const start = Effect.fnUntraced(function* (mode: string) {
              const port = yield* freePort
              const lines: Array<string> = []

              const child = yield* spawner.spawn(
                ChildProcess.make("bun", [new URL("./runner.ts", import.meta.url).pathname], {
                  env: {
                    DRILL_DATABASE_URL: database.href,
                    DRILL_PROVIDER_URL: providerUrl,
                    DRILL_PORT: String(port),
                    DRILL_FAULT: mode,
                  },
                  extendEnv: true,
                  stderr: "inherit",
                }),
              )

              yield* child.stdout.pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.runForEach((line) => Effect.sync(() => lines.push(line))),
                Effect.forkScoped,
              )

              yield* until(
                Effect.sync(() => (lines.includes("LISTENING") ? true : undefined)),
                `runner ${mode} to listen`,
                "30 seconds",
              )

              return { child, lines, url: `http://127.0.0.1:${port}` }
            })

            const client = yield* HttpClient.HttpClient

            const call = (
              url: string,
              options: {
                readonly method?: "GET" | "POST"
                readonly key?: string
                readonly body?: unknown
              } = {},
            ) =>
              HttpClientRequest.make(options.method ?? "GET")(url).pipe(
                HttpClientRequest.bearerToken("ada"),
                options.key === undefined
                  ? identity
                  : HttpClientRequest.setHeader("idempotency-key", options.key),
                options.body === undefined
                  ? identity
                  : HttpClientRequest.bodyJsonUnsafe(options.body),
                client.execute,
                Effect.flatMap((response) =>
                  response.json.pipe(Effect.map((body) => ({ status: response.status, body }))),
                ),
              )

            const first = yield* start(fault)

            const key = yield* call(`${first.url}/command-ids`, { method: "POST" }).pipe(
              Effect.flatMap(({ body }) =>
                Schema.decodeUnknownEffect(Schema.Struct({ commandId: Schema.String }))(body),
              ),
              Effect.map(({ commandId }) => commandId),
              Effect.orDie,
            )

            const place = (url: string) =>
              call(`${url}/orders/drill-1`, { method: "POST", key, body: ORDER })

            const reply = yield* place(first.url).pipe(Effect.forkScoped)

            yield* until(
              Effect.sync(() => (first.lines.includes(`FAULT ${fault}`) ? true : undefined)),
              `the runner to reach ${fault}`,
              "30 seconds",
            )

            if (acknowledged)
              expect(yield* Fiber.join(reply).pipe(Effect.orDie)).toMatchObject({ status: 200 })

            const killedAt = yield* Clock.currentTimeMillis
            yield* first.child.kill({ killSignal: "SIGKILL" })
            expect(String((yield* first.child.exitCode.pipe(Effect.flip)).cause)).toContain(
              "SIGKILL",
            )

            if (!acknowledged) expect(Exit.isFailure(yield* Fiber.await(reply))).toBe(true)

            const second = yield* start("none")

            const retried = yield* place(second.url).pipe(Effect.orDie)
            expect(retried.status).toBe(200)

            const placed = yield* Schema.decodeUnknownEffect(Placed)(retried.body).pipe(
              Effect.orDie,
            )

            expect(placed).toMatchObject({ orderId: "drill-1", total: TOTAL })
            expect(placed.shipments).toHaveLength(2)

            const summary = yield* until(
              call(`${second.url}/orders/drill-1`).pipe(
                Effect.orDie,
                Effect.flatMap(({ body }) => Schema.decodeUnknownEffect(Summary)(body)),
                Effect.orDie,
                Effect.map((decoded) => (decoded.status === "paid" ? decoded : undefined)),
              ),
              "the order to be paid",
              "60 seconds",
            )

            const recoveredAt = yield* Clock.currentTimeMillis

            for (const id of placed.shipments)
              yield* until(
                call(`${second.url}/actors/Shipment/${id}/Tracking`, { method: "POST" }).pipe(
                  Effect.flatMap(({ body }) => Schema.decodeUnknownEffect(Tracking)(body)),
                  Effect.option,
                  Effect.map((tracking) =>
                    Option.isSome(tracking) && tracking.value.status === "ready" ? true : undefined,
                  ),
                ),
                `shipment ${id} to be released`,
                "60 seconds",
              )

            yield* until(
              count("SELECT count(*) FROM actor_outbox").pipe(
                Effect.map((rows) => (rows === 0 ? true : undefined)),
              ),
              "the outbox to drain",
              "60 seconds",
            )

            const applied = [...ledger.charges.values()]
            expect(applied).toEqual([
              { chargeId: summary.chargeId, customerId: "ada", amount: TOTAL },
            ])

            const [effectId] = [...ledger.charges.keys()]
            const calls = ledger.calls.get(effectId!) ?? 0

            if (fault === "afterExecute:Charge") expect(calls).toBeGreaterThanOrEqual(2)
            else expect(calls).toBeGreaterThanOrEqual(1)

            const receipts = (command: string, actor: string) =>
              count("SELECT count(*) FROM actor_receipts WHERE actor_type = $1 AND command = $2", [
                actor,
                command,
              ])

            expect(yield* receipts("Place", "Order")).toBe(1)
            expect(yield* receipts("Charged", "Order")).toBe(1)
            expect(yield* receipts("ChargeFailed", "Order")).toBe(0)
            expect(yield* receipts("Open", "Shipment")).toBe(2)
            expect(yield* receipts("Release", "Shipment")).toBe(2)
            expect(yield* count("SELECT count(*) FROM order_lines")).toBe(ORDER.items.length)
            expect(
              yield* count(
                "SELECT count(*) FROM actor_generations WHERE actor_type = 'Shipment' AND created",
              ),
            ).toBe(2)

            yield* Console.error(
              `DRILL fault=${fault} acknowledged=${acknowledged} providerCalls=${calls} appliedCharges=${applied.length} recoveryMs=${recoveredAt - killedAt}`,
            )
            yield* second.child.kill({ killSignal: "SIGKILL" })
          }).pipe(Effect.scoped, Effect.timeout("150 seconds")),
        ),
      160_000,
    )
})
