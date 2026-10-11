import { Context, Deferred, Effect, Exit, Fiber, Layer, Schedule, Schema, Scope } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"
import {
  Actor,
  Actors as ActorClient,
  Intent,
  User,
} from "../../../../../packages/akter/src/index.ts"
import {
  Actors,
  Auth,
  Inspector,
  Database,
} from "../../../../../packages/akter/src/runtime/index.ts"
import type { RunnerWiring } from "../../../../../packages/akter/src/runtime/runner.ts"

/** Exercises the same bounded serving, replay and workflow restart obligations on either transport. */
export const poolServing = ({
  database,
  wiring = Layer.empty,
}: {
  readonly database: ReturnType<typeof Database.postgres>
  readonly wiring?: Layer.Layer<RunnerWiring> | Layer.Layer<never>
}) =>
  Effect.gen(function* () {
    const holdStarted = yield* Deferred.make<void>()
    const releaseTurn = yield* Deferred.make<void>()
    const jobStarted = yield* Deferred.make<void>()
    const releaseJob = yield* Deferred.make<void>()
    const workflowStarted = yield* Deferred.make<void>()
    const releaseWorkflow = yield* Deferred.make<void>()
    const interruptStarted = yield* Deferred.make<void>()
    const Add = Actor.command("Add", { payload: Schema.Int, success: Schema.Int })
    const Hold = Actor.command("Hold")
    const Stage = Actor.command("Stage")
    const Settle = Actor.command("Settle", { payload: Schema.Int })
    const Value = Actor.query("Value", { success: Schema.Int })
    const Job = Actor.job("PoolJob", { payload: { amount: Schema.Int }, success: Schema.Int })
    const Work = Actor.workflow("Work", {
      payload: { amount: Schema.Int },
      success: Schema.Int,
    })
    const Call = Work.step("call", { payload: Schema.Int, success: Schema.Int })
    const Nap = Work.sleep("nap")
    const Probe = Actor.make("LowConnectionProbe", {
      key: Schema.String,
      state: Actor.state({
        total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
      }),
      api: { Add, Hold, Stage, Value, Work },
      internal: { Settle },
      jobs: { PoolJob: { job: Job, onSuccess: Settle } },
    })
    const app = Layer.mergeAll(
      Probe.toLayer(
        Effect.succeed({
          Add: Effect.fnUntraced(function* (amount: number) {
            const turn = yield* Probe.Turn
            yield* turn.state.set({ total: turn.state.total + amount })
            return turn.state.total
          }),
          Hold: Effect.fnUntraced(function* () {
            const turn = yield* Probe.Turn
            yield* turn.state.set({ total: turn.state.total + 101 })
            yield* Deferred.succeed(holdStarted, undefined)
            yield* Deferred.await(releaseTurn)
          }),
          Stage: Effect.fnUntraced(function* () {
            yield* (yield* Probe.Turn).enqueue(Job.make({ amount: 11 }))
            yield* (yield* Probe.intents("relay")).Add(7).pipe(Intent.after("1 second"))
          }),
          Settle: Effect.fnUntraced(function* (amount: number) {
            const turn = yield* Probe.Turn
            yield* turn.state.set({ total: turn.state.total + amount })
          }),
          Work: ({ amount }: { readonly amount: number }) =>
            Call.run(
              amount,
              Effect.fnUntraced(function* (value: number) {
                if (value < 0) {
                  yield* Deferred.succeed(interruptStarted, undefined)
                  return yield* Effect.never
                }
                yield* Deferred.succeed(workflowStarted, undefined)
                yield* Deferred.await(releaseWorkflow)
                return yield* (yield* Probe.get("workflow")).Add(value).pipe(Effect.orDie)
              }),
            ).pipe(Effect.tap(() => Nap("2 seconds"))),
        }),
      ),
      Probe.toQueryLayer(
        Effect.succeed({
          Value: Effect.fnUntraced(function* () {
            return (yield* Probe.Read).state.total
          }),
        }),
      ),
      Probe.toJobLayer(
        Effect.succeed({
          PoolJob: Effect.fnUntraced(function* ({ amount }: { readonly amount: number }) {
            yield* Deferred.succeed(jobStarted, undefined)
            yield* Deferred.await(releaseJob)
            return yield* (yield* Probe.get("job")).Add(amount)
          }),
        }),
      ),
    ).pipe(
      Layer.provideMerge(
        Actors.layer({
          authorize: () => Effect.succeed(true),
          relay: { poll: "100 millis" },
          executors: { lease: "3 seconds" },
        }).pipe(Layer.provide(wiring)),
      ),
      Layer.provideMerge(database),
    )
    const appScope = yield* Scope.fork(yield* Effect.scope)
    const context = yield* Layer.build(app).pipe(Scope.provide(appScope))
    const sql = Context.get(context, SqlClient.SqlClient)
    const auth = Auth.make(() =>
      Effect.succeed({ tenant: "default", caller: User.make({ subject: "pool-test" }) }),
    )
    const web = HttpRouter.toWebHandler(
      Layer.merge(Actors.serve({ actors: [Probe], auth }), Inspector.serve({ auth })).pipe(
        Layer.provide(Layer.succeedContext(context)),
      ),
      { disableLogger: true },
    )
    yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: (request) => web.handler(request),
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    yield* Effect.addFinalizer(() =>
      Effect.all([
        Deferred.succeed(releaseTurn, undefined),
        Deferred.succeed(releaseJob, undefined),
        Deferred.succeed(releaseWorkflow, undefined),
      ]),
    )
    const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient)
    const send = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const response = yield* client.execute(request)
        return { status: response.status, body: yield* response.json }
      })
    const probe = yield* Effect.provide(Probe.get("source"), context)
    const id = yield* Effect.provide(
      Effect.flatMap(ActorClient, (actors) => actors.mintCommandId),
      context,
    )
    const request = HttpClientRequest.post(
      new URL("/actors/LowConnectionProbe/source/Add", server.url).href,
      { headers: { "idempotency-key": id } },
    ).pipe(HttpClientRequest.bodyText("3", "application/json"))
    expect(yield* send(request)).toEqual({ status: 200, body: 3 })
    const run = yield* Effect.provide(probe.Work({ amount: 23 }), context)
    yield* Deferred.await(workflowStarted)
    yield* Effect.provide(probe.Stage(), context)
    yield* Deferred.await(jobStarted)
    const hold = yield* Effect.provide(probe.Hold(), context).pipe(Effect.forkScoped)
    yield* Deferred.await(holdStarted)
    yield* Deferred.succeed(releaseJob, undefined)
    yield* Deferred.succeed(releaseWorkflow, undefined)
    yield* Effect.sleep("1200 millis")

    expect(hold.pollUnsafe()).toBeUndefined()
    expect(
      yield* send(
        HttpClientRequest.post(new URL("/actors/LowConnectionProbe/source/Value", server.url).href),
      ),
    ).toEqual({ status: 200, body: 3 })
    expect(
      yield* send(HttpClientRequest.get(new URL("/inspector/overview", server.url).href)),
    ).toMatchObject({
      status: 200,
      body: { counts: { jobs: 1, openWorkflows: 1 } },
    })
    const [renewed] = yield* sql<{ attempts: number; remaining: number }>`SELECT attempts,
    due_at_ms - floor(extract(epoch FROM clock_timestamp()) * 1000) AS remaining
    FROM actor_outbox WHERE kind = 'job'`
    expect(renewed?.attempts).toBe(1)
    expect(Number(renewed?.remaining)).toBeGreaterThan(2000)
    expect(
      yield* sql`SELECT attempts FROM actor_outbox WHERE kind = 'intent' AND target_id = 'relay'`,
    ).toEqual([{ attempts: 1 }])
    yield* Deferred.succeed(releaseTurn, undefined)
    yield* Fiber.join(hold)
    expect(yield* run.result.pipe(Effect.provide(context))).toBe(23)
    yield* sql`SELECT 1 FROM actor_outbox`.pipe(
      Effect.flatMap((rows) => (rows.length === 0 ? Effect.void : Effect.fail("pending"))),
      Effect.retry({ times: 200, schedule: Schedule.spaced("10 millis") }),
    )
    expect(yield* Effect.provide(probe.Value(), context)).toBe(115)
    expect(
      yield* Effect.provide(
        Effect.flatMap(Probe.get("job"), (actor) => actor.Value()),
        context,
      ),
    ).toBe(11)
    expect(
      yield* Effect.provide(
        Effect.flatMap(Probe.get("relay"), (actor) => actor.Value()),
        context,
      ),
    ).toBe(7)
    expect(yield* send(request)).toEqual({ status: 200, body: 3 })
    expect(yield* Effect.provide(probe.Value(), context)).toBe(115)

    const interrupted = yield* Effect.provide(probe.Work({ amount: -1 }), context)
    yield* Deferred.await(interruptStarted)
    yield* Effect.provide(interrupted.interrupt, context)
    const exit = yield* Effect.provide(interrupted.result, context).pipe(Effect.exit)
    expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true)
    expect(yield* send(HttpClientRequest.get(new URL("/ready", server.url).href))).toMatchObject({
      status: 200,
      body: { ready: true },
    })
    expect(yield* Effect.provide(probe.Add(17), context)).toBe(132)

    const sleeping = yield* Effect.provide(probe.Work({ amount: 31 }), context)
    yield* sql`SELECT 1 FROM actor_workflow_executions
    WHERE execution_id = ${sleeping.executionId} AND status = 'suspended'`.pipe(
      Effect.flatMap((rows) => (rows.length === 1 ? Effect.void : Effect.fail("not parked"))),
      Effect.retry({ times: 200, schedule: Schedule.spaced("10 millis") }),
    )
    yield* Scope.close(appScope, Exit.void)
    const recovered = yield* Layer.build(app)
    const attached = yield* Effect.provide(Probe.run(Work, sleeping.executionId), recovered)
    expect(yield* Effect.provide(attached.result, recovered)).toBe(54)
    const recoveredSql = Context.get(recovered, SqlClient.SqlClient)
    expect(
      yield* recoveredSql`SELECT count(*)::int AS count FROM actor_receipts
    WHERE actor_id = 'workflow' AND command = 'Add'`,
    ).toEqual([{ count: 2 }])
    expect(
      yield* Effect.provide(
        Effect.flatMap(Probe.get("workflow"), (actor) => actor.Value()),
        recovered,
      ),
    ).toBe(54)
  }).pipe(Effect.timeout("15 seconds"))
