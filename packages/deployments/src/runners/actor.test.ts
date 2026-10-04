import { migrate } from "@akter/postgres/migrate"
import { BunCrypto } from "@effect/platform-bun"
import { ActorTest } from "@rikalabs/akter/testing"
import { Actor } from "@rikalabs/akter"
import {
  Config,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
  Schema,
} from "effect"
import { RuntimeControl } from "@rikalabs/akter/runtime"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { RunnerLayers, Runners, runnerKey, runnerActor } from "./actor.ts"
import { platformError, RunnerPlatform } from "./contract.ts"

const starts = new Map<string, { id: string; url: string; basePath: string }>()
const stopped: string[] = []
const calls: string[] = []
let rejectStart = false
let rejectStop = false
let loseAcceptedReply = false
let heldStart:
  | { deploymentId: string; reached: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
  | undefined
let heldStop:
  | { id: string; reached: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
  | undefined
let addressLater: "fail" | { reached: Deferred.Deferred<void> } | undefined
const answer = (result: { id: string; url: string; basePath: string }) =>
  addressLater === undefined
    ? { ...result, state: "running" as const }
    : { ...result, url: null, state: "starting" as const }
const fake = Layer.succeed(RunnerPlatform, {
  start: (spec) =>
    Effect.suspend(() => {
      if (rejectStart) return platformError({ operation: "start", code: "refused" })
      const existing = starts.get(spec.idempotencyKey)
      if (existing !== undefined && loseAcceptedReply)
        return platformError({ operation: "start", code: "unavailable" })
      if (existing !== undefined) return Effect.succeed(answer(existing))
      const result = {
        id: `task-${starts.size + 1}`,
        url: `http://127.0.0.1:${20000 + starts.size}`,
        basePath: "",
      }
      starts.set(spec.idempotencyKey, result)
      calls.push(`start:${result.id}`)
      if (loseAcceptedReply) return platformError({ operation: "start", code: "unavailable" })
      const wait =
        heldStart?.deploymentId === spec.deploymentId
          ? Deferred.succeed(heldStart.reached, undefined).pipe(
              Effect.andThen(Deferred.await(heldStart.release)),
            )
          : Effect.void
      return wait.pipe(Effect.as(answer(result)))
    }),
  stop: (id) =>
    Effect.suspend(() => {
      if (rejectStop) return platformError({ operation: "stop", code: "refused" })
      calls.push(`stop:${id}`)
      const gate = heldStop
      const wait =
        gate?.id === id
          ? Deferred.succeed(gate.reached, undefined).pipe(
              Effect.andThen(Deferred.await(gate.release)),
            )
          : Effect.void
      return wait.pipe(
        Effect.andThen(
          Effect.sync(() => {
            stopped.push(id)
          }),
        ),
      )
    }),
  describe: (id) => {
    if (addressLater === "fail")
      return platformError({ operation: "describe", code: "unavailable" })
    if (addressLater !== undefined)
      return Deferred.succeed(addressLater.reached, undefined).pipe(Effect.andThen(Effect.never))
    return Effect.succeed({
      id,
      state: stopped.includes(id) ? ("stopped" as const) : ("running" as const),
      url: null,
      basePath: "",
    })
  },
})

const live = Layer.unwrap(
  Effect.gen(function* () {
    const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
    const name = `runners_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`
    const admin = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: base.href })),
      (pool) => Effect.promise(() => pool.end()),
    )
    yield* Effect.acquireRelease(
      Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
      () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
    )
    base.pathname = `/${name}`
    yield* Effect.promise(() => migrate(base.href))
    return RunnerLayers.pipe(
      Layer.provide(fake),
      Layer.provideMerge(ActorTest.layer({ database: Redacted.make(base.href) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)
const runtime = ManagedRuntime.make(live)
afterAll(() => runtime.dispose(), 60000)
const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof live>>) =>
  runtime.runPromise(effect)

afterEach(() => {
  rejectStart = false
  rejectStop = false
  loseAcceptedReply = false
  heldStart = undefined
  heldStop = undefined
  addressLater = undefined
})

const exhaustRetries = Effect.gen(function* () {
  const test = yield* ActorTest
  for (let attempt = 0; attempt < 5; attempt++) yield* test.advance("10 seconds")
})

const register = (id: string, tier = "free") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO deployment (id, primary_region, image, tier, scale_to_zero) VALUES (${id}, 'local', 'example@sha256:abc', ${tier}, ${tier === "free"})`.pipe(
      Effect.orDie,
    )
    return yield* Runners.get(runnerKey(id, "local"))
  })

const status = Effect.fnUntraced(function* (id: string) {
  const test = yield* ActorTest
  const runner = yield* Runners.get(runnerKey(id, "local"))
  return yield* Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.String }))(
    (yield* test.inspect(runner.ref)).state,
  ).pipe(Effect.orDie)
})

describe("durable runner provisioning", () => {
  it("retains the provisioning identity after all replies are lost, then recovers or cleans up that same resource", () =>
    run(
      Effect.gen(function* () {
        const runner = yield* register("lost-reply")
        const test = yield* ActorTest
        const before = starts.size
        loseAcceptedReply = true
        yield* runner.Wake()
        yield* exhaustRetries
        expect(yield* status("lost-reply")).toEqual({ status: "failed" })
        expect(starts.size).toBe(before + 1)
        loseAcceptedReply = false
        yield* runner.Wake()
        yield* test.advance(0)
        expect(yield* status("lost-reply")).toEqual({ status: "running" })
        expect(starts.size).toBe(before + 1)
        const cleanup = yield* register("lost-cleanup")
        loseAcceptedReply = true
        yield* cleanup.Wake()
        yield* exhaustRetries
        loseAcceptedReply = false
        const created = starts.size
        const resource = [...starts.values()].at(-1)!.id
        yield* cleanup.Drain()
        yield* test.advance(0)
        expect(yield* status("lost-cleanup")).toEqual({ status: "stopped" })
        expect(starts.size).toBe(created)
        expect(stopped).toContain(resource)
      }),
    ))
  it("uses one control-plane capacity actor when wakes originate from different organization tenants", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO deployment (id, primary_region, image, tier, scale_to_zero) VALUES ('shared-wake', 'local', 'example@sha256:abc', 'free', true)`.pipe(
          Effect.orDie,
        )
        const first = yield* runnerActor("shared-wake", "local").pipe(Actor.tenant("org-first"))
        const second = yield* runnerActor("shared-wake", "local").pipe(Actor.tenant("org-second"))
        expect(first.ref).toEqual(second.ref)
        expect(first.ref.tenant).toBe("control-plane")
        const count = starts.size
        yield* Effect.all([first.Wake(), second.Wake()], { concurrency: "unbounded" })
        yield* (yield* ActorTest).advance(0)
        expect(starts.size).toBe(count + 1)
        expect(yield* first.Lookup()).toMatchObject({ status: "running" })
        expect(
          yield* sql`SELECT provider_id FROM deployment_runner WHERE deployment_id = 'shared-wake'`,
        ).toHaveLength(1)
      }),
    ))
  it("serializes concurrent wakes and only registers one task", () =>
    run(
      Effect.gen(function* () {
        const runner = yield* register("burst")
        const initial = starts.size
        yield* Effect.forEach(Array.from({ length: 12 }), () => runner.Wake(), {
          concurrency: "unbounded",
        })
        yield* (yield* ActorTest).advance(0)
        expect(starts.size).toBe(initial + 1)
        const sql = yield* SqlClient.SqlClient
        expect(
          yield* sql`SELECT url FROM deployment_runner WHERE deployment_id = 'burst'`,
        ).toHaveLength(1)
        expect(yield* status("burst")).toEqual({ status: "running" })
      }),
    ))

  it("withdraws before drain, only Free idles, and waking again gets a fresh job identity", () =>
    run(
      Effect.gen(function* () {
        const free = yield* register("idle-free")
        const paid = yield* register("idle-paid", "pro")
        yield* free.Wake()
        yield* paid.Wake()
        const test = yield* ActorTest
        yield* test.advance(0)
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE deployment SET last_activity_at = now() - interval '1 hour' WHERE id IN ('idle-free', 'idle-paid')`.pipe(
          Effect.orDie,
        )
        yield* sql`UPDATE deployment SET scale_to_zero = true WHERE id = 'idle-paid'`.pipe(
          Effect.orDie,
        )
        const capacity = yield* free.Lookup()
        const reached = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        heldStop = { id: capacity.taskId!, reached, release }
        yield* free.Idle({ idleSeconds: 60 })
        yield* paid.Idle({ idleSeconds: 60 })
        const advancing = yield* test.advance(0).pipe(Effect.forkChild)
        yield* Effect.gen(function* () {
          yield* Deferred.await(reached)
          expect(
            yield* sql`SELECT url FROM deployment_runner WHERE deployment_id = 'idle-free'`,
          ).toHaveLength(0)
          expect(
            yield* sql`SELECT url FROM deployment_runner WHERE deployment_id = 'idle-paid'`,
          ).toHaveLength(1)
          expect(yield* status("idle-free")).toEqual({ status: "stopping" })
          expect(stopped).not.toContain(capacity.taskId)
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
        yield* Fiber.join(advancing)
        heldStop = undefined
        yield* test.advance(0)
        expect(yield* status("idle-free")).toEqual({ status: "stopped" })
        expect(stopped).toContain(capacity.taskId)
        const count = starts.size
        yield* free.Wake()
        yield* test.advance(0)
        expect(starts.size).toBe(count + 1)
        expect(yield* status("idle-free")).toEqual({ status: "running" })
      }),
    ))

  it("does not launch a provider job before the Wake turn commits", () =>
    run(
      Effect.gen(function* () {
        const runner = yield* register("interrupted")
        const test = yield* ActorTest
        const pause = yield* test.pauseNext("beforeCommit")
        const fiber = yield* runner.Wake().pipe(Effect.forkChild)
        yield* pause.reached
        const count = starts.size
        yield* test.advance(0)
        expect(starts.size).toBe(count)
        yield* pause.release
        expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
        yield* test.advance(0)
        expect(starts.size).toBe(count + 1)
      }),
    ))

  it("persists failed starts and drains without registering or duplicating an orphan", () =>
    run(
      Effect.gen(function* () {
        const runner = yield* register("provider-failures")
        const test = yield* ActorTest
        rejectStart = true
        yield* runner.Wake()
        yield* exhaustRetries
        rejectStart = false
        expect(yield* status("provider-failures")).toEqual({ status: "failed" })
        const sql = yield* SqlClient.SqlClient
        expect(
          yield* sql`SELECT url FROM deployment_runner WHERE deployment_id = 'provider-failures'`,
        ).toHaveLength(0)
        yield* runner.Wake()
        yield* test.advance(0)
        rejectStop = true
        yield* runner.Drain()
        yield* exhaustRetries
        rejectStop = false
        expect(yield* status("provider-failures")).toEqual({ status: "stop-failed" })
        const stuck = (yield* runner.Lookup()).taskId!
        const mark = calls.length
        yield* runner.Wake()
        yield* test.advance(0)
        const replacement = yield* runner.Lookup()
        expect(replacement.status).toBe("running")
        expect(replacement.taskId).not.toBe(stuck)
        expect(calls.slice(mark)).toEqual([`stop:${stuck}`, `start:${replacement.taskId}`])
        expect(
          yield* sql`SELECT provider_id AS "providerId" FROM deployment_runner WHERE deployment_id = 'provider-failures'`,
        ).toEqual([{ providerId: replacement.taskId }])
        yield* runner.Drain()
        yield* test.advance(0)
        expect(yield* status("provider-failures")).toEqual({ status: "stopped" })
      }),
    ))

  it("ignores a poller wake that lands after the deployment stopped serving, including mid-drain", () =>
    run(
      Effect.gen(function* () {
        const runner = yield* register("stale-wake", "pro")
        const test = yield* ActorTest
        const sql = yield* SqlClient.SqlClient
        const before = starts.size
        yield* runner.WakeIfServing()
        yield* test.advance(0)
        expect(starts.size).toBe(before + 1)
        const warm = yield* runner.Lookup()
        expect(warm.status).toBe("running")
        yield* sql`UPDATE deployment SET serving = false WHERE id = 'stale-wake'`.pipe(Effect.orDie)
        yield* runner.Drain()
        yield* runner.WakeIfServing()
        yield* test.advance(0)
        yield* runner.WakeIfServing()
        yield* test.advance(0)
        expect(yield* status("stale-wake")).toEqual({ status: "stopped" })
        expect(starts.size).toBe(before + 1)
        expect(stopped).toContain(warm.taskId)
        expect(
          yield* sql`SELECT url FROM deployment_runner WHERE deployment_id = 'stale-wake'`,
        ).toHaveLength(0)
      }),
    ))

  it("still stops the task when address resolution fails with a typed provider error", () =>
    run(
      Effect.gen(function* () {
        const runner = yield* register("typed-describe-failure")
        addressLater = "fail"
        yield* runner.Wake()
        yield* exhaustRetries
        const task = [...starts.values()].at(-1)!.id
        expect(yield* status("typed-describe-failure")).toEqual({ status: "failed" })
        expect(stopped).toContain(task)
        const sql = yield* SqlClient.SqlClient
        expect(
          yield* sql`SELECT url FROM deployment_runner WHERE deployment_id = 'typed-describe-failure'`,
        ).toHaveLength(0)
      }),
    ))

  it("withdraws an externally stopped runner and wakes a replacement with a new provider identity", () =>
    run(
      Effect.gen(function* () {
        const runner = yield* register("crashed")
        const test = yield* ActorTest
        yield* runner.Wake()
        yield* test.advance(0)
        const capacity = yield* runner.Lookup()
        expect(capacity.taskId).not.toBeNull()
        stopped.push(capacity.taskId!)
        yield* runner.Reconcile()
        yield* test.advance(0)
        expect(yield* status("crashed")).toEqual({ status: "stopped" })
        const sql = yield* SqlClient.SqlClient
        expect(
          yield* sql`SELECT url FROM deployment_runner WHERE deployment_id = 'crashed'`,
        ).toHaveLength(0)
        yield* runner.Wake()
        yield* test.advance(0)
        expect((yield* runner.Lookup()).taskId).not.toBe(capacity.taskId)
      }),
    ))

  it("retains a drain requested while startup is waiting and never advertises that task", () =>
    run(
      Effect.gen(function* () {
        const runner = yield* register("drain-starting")
        const reached = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        heldStart = { deploymentId: "drain-starting", reached, release }
        yield* runner.Wake()
        const test = yield* ActorTest
        const advancing = yield* test.advance(0).pipe(Effect.forkChild)
        yield* Deferred.await(reached)
        yield* runner.Drain()
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(advancing)
        heldStart = undefined
        yield* test.advance(0)
        const sql = yield* SqlClient.SqlClient
        expect(
          yield* sql`SELECT url FROM deployment_runner WHERE deployment_id = 'drain-starting'`,
        ).toHaveLength(0)
        expect(yield* status("drain-starting")).toEqual({ status: "stopped" })
        expect(stopped).toContain([...starts.values()].at(-1)!.id)
      }),
    ))

  it(
    "leaves a task to its durable retry when the process interrupts startup",
    () =>
      Effect.runPromise(
        Effect.acquireUseRelease(
          Effect.sync(() => ManagedRuntime.make(live)),
          (isolated) =>
            Effect.promise(() =>
              isolated.runPromise(
                Effect.gen(function* () {
                  const runner = yield* register("interrupted-start")
                  const reached = yield* Deferred.make<void>()
                  addressLater = { reached }
                  yield* runner.Wake()
                  yield* (yield* ActorTest).advance(0).pipe(Effect.forkChild)
                  yield* Deferred.await(reached)
                  const task = [...starts.values()].at(-1)!.id
                  const report = yield* (yield* RuntimeControl).drain({ deadline: "200 millis" })
                  expect(report).toMatchObject({ outcome: "deadline-expired", interruptedJobs: 1 })
                  expect(stopped).not.toContain(task)
                }),
              ),
            ),
          (isolated) => Effect.promise(() => isolated.dispose()),
        ),
      ),
    60000,
  )
})
