import { BunCrypto } from "@effect/platform-bun"
import { Actors, Auth, RuntimeControl } from "@durable-actors/core/runtime"
import {
  Clock,
  Context,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Layer,
  Schedule,
  Schema,
  Scope,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { SqlClient } from "effect/sql"
import { load, now, summarize, throughput } from "../measure.ts"
import { Probe, Sender } from "../probe/contract.ts"
import { deliveries } from "../probe/layer.ts"
import { type CaseResult, caseRuntime, DEFAULT_POOL, type Scenario } from "../scenario.ts"

const ProtocolInfo = Schema.Struct({ retryWindowMs: Schema.Int, now: Schema.Int })

const decodeProtocol = Schema.decodeUnknownEffect(Schema.fromJsonString(ProtocolInfo))

/** A served runner on the case database: `Actors.layer` and `Actors.serve` on a Bun listener. */
const startRunner = Effect.fnUntraced(function* (database: Context.Context<SqlClient.SqlClient>) {
  const scope = yield* Scope.make()

  const services = yield* Layer.build(
    caseRuntime.pipe(Layer.provideMerge(Layer.succeedContext(database))),
  ).pipe(Scope.provide(scope))

  const web = HttpRouter.toWebHandler(
    Actors.serve({ actors: [Probe], auth: Auth.none }).pipe(
      Layer.provide(Layer.succeedContext(services)),
    ),
    { disableLogger: true },
  )

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => web.handler(request),
  })

  yield* Scope.addFinalizer(
    scope,
    Effect.promise(() => server.stop(true)).pipe(
      Effect.andThen(Effect.promise(() => web.dispose())),
    ),
  )

  return { url: `http://127.0.0.1:${server.port}`, scope, services }
})

type Runner = Effect.Success<ReturnType<typeof startRunner>>

/** Drains the runner as a platform scaling it to zero would, then stops it. */
const stopRunner = (runner: Runner) =>
  RuntimeControl.use((control) => control.drain({ deadline: "5 seconds" })).pipe(
    Effect.provideContext(runner.services),
    Effect.andThen(Scope.close(runner.scope, Exit.void)),
  )

/**
 * Warm and cold served latency, reported separately. `warm` is a served
 * command to a runner that is already up. Each cold drill stops the last
 * runner with a drain, lets `due` intents come due while no runner exists,
 * then starts a new runtime and server on the same database and times, from
 * the start: `GET /ready` answering 200, the first command's answer (an
 * existing actor, so its state is read), and every due intent delivered.
 *
 * The runner starts inside the benchmark process, so process boot and module
 * loading are not included; add the platform's process start to these numbers.
 */
export const coldStart: Scenario = {
  name: "cold-start",
  description:
    "Scale-to-zero serving: served command latency on a warm runner, then repeated drills that drain and stop the only runner, let intents come due with no runner, and time a new runner's /ready, first answered command, and delivery of every due intent from its start.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.quick
      const drills = quick ? 5 : 30
      const results: Array<CaseResult> = []
      const database = yield* context.backend.database({ maxConnections: DEFAULT_POOL })
      const sql = yield* Layer.build(database.layer)
      const crypto = Context.get(yield* Layer.build(BunCrypto.layer), Crypto.Crypto)
      const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient)

      const get = (url: string) => client.execute(HttpClientRequest.get(url))

      let runner = yield* startRunner(sql)

      const protocol = yield* get(`${runner.url}/protocol`).pipe(
        Effect.flatMap((response) => response.text),
        Effect.flatMap(decodeProtocol),
        Effect.orDie,
      )

      const offset = protocol.now - (yield* Clock.currentTimeMillis)

      const command = (url: string, id: string) =>
        Effect.gen(function* () {
          const issued = (yield* Clock.currentTimeMillis) + offset - 1000
          const key = `v1.${issued}.${issued + protocol.retryWindowMs}.${yield* crypto.randomUUIDv4}`

          const response = yield* client.execute(
            HttpClientRequest.post(`${url}/actors/Probe/${id}/Add`, {
              headers: { "idempotency-key": key },
            }).pipe(HttpClientRequest.bodyText("1", "application/json")),
          )

          if (response.status !== 200)
            return yield* Effect.die(new Error(`Command answered ${response.status}`))
        })

      yield* load({ workers: 1, operations: 50, operation: () => command(runner.url, "cold") })

      const warmUrl = runner.url

      const warm = yield* load({
        workers: 1,
        operations: quick ? 100 : 1000,
        operation: () => command(warmUrl, "cold"),
      })

      const coldCase = (due: number) =>
        Effect.gen(function* () {
          const ready: Array<number> = []
          const answered: Array<number> = []
          const drained: Array<number> = []

          for (let drill = 0; drill < drills; drill++) {
            const ids = Array.from({ length: due }, (_, index) => `cold-${due}-${drill}-${index}`)

            const pending = yield* Effect.forEach(ids, (id) =>
              Deferred.make<void>().pipe(
                Effect.tap((done) => Effect.sync(() => deliveries.set(id, done))),
              ),
            )

            const atMs = (yield* Clock.currentTimeMillis) + offset + 200

            if (due > 0)
              yield* Sender.get(`cold-${drill}`).pipe(
                Effect.flatMap((sender) => sender.SendAt({ ids, atMs })),
                Effect.provideContext(runner.services),
                Effect.orDie,
              )

            yield* stopRunner(runner)
            yield* Effect.sleep("400 millis")

            const started = yield* now
            runner = yield* startRunner(sql)
            const url = runner.url

            yield* get(`${url}/ready`).pipe(
              Effect.map((response) => response.status),
              Effect.orElseSucceed(() => 0),
              Effect.repeat({
                schedule: Schedule.spaced("1 millis"),
                until: (status) => status === 200,
              }),
            )

            ready.push((yield* now) - started)
            yield* command(url, "cold").pipe(Effect.orDie)
            answered.push((yield* now) - started)
            yield* Effect.forEach(pending, Deferred.await, { discard: true })
            drained.push((yield* now) - started)

            for (const id of ids) deliveries.delete(id)
          }

          const digest = (name: string, samples: ReadonlyArray<number>) => {
            const summary = summarize(samples)

            return {
              [`${name}P50`]: summary.p50,
              [`${name}P95`]: summary.p95,
              [`${name}Max`]: summary.max,
            }
          }

          return {
            name: `cold-due-${due}`,
            parameters: { drills, due },
            operations: drills,
            elapsedMs: Math.round(drained.reduce((total, sample) => total + sample, 0)),
            throughput: 0,
            errors: 0,
            errorKinds: {},
            latencyMs: summarize(answered),
            statementsPerOperation: null,
            roundTripsPerOperation: null,
            statements: null,
            activity: null,
            cpu: {
              client: 0,
              server: null,
              clientMsPerOperation: null,
              serverMsPerOperation: null,
            },
            extra: {
              ...digest("readyMs", ready),
              ...digest("firstAnswerMs", answered),
              ...digest("dueDeliveredMs", drained),
            },
          } satisfies CaseResult
        })

      results.push({
        name: "warm",
        parameters: { workers: 1 },
        operations: warm.samples.length,
        elapsedMs: Math.round(warm.elapsedMs),
        throughput: throughput(warm),
        errors: warm.errors,
        errorKinds: warm.errorKinds,
        latencyMs: summarize(warm.samples),
        statementsPerOperation: null,
        roundTripsPerOperation: null,
        statements: null,
        activity: null,
        cpu: { client: 0, server: null, clientMsPerOperation: null, serverMsPerOperation: null },
        extra: null,
      })

      results.push(yield* coldCase(0))
      results.push(yield* coldCase(quick ? 100 : 1000))

      yield* stopRunner(runner)

      return results
    }).pipe(Effect.scoped),
}
