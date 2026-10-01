import { BunCrypto, BunServices } from "@effect/platform-bun"
import { RuntimeControl } from "@durable-actors/core/runtime"
import { ActorTest } from "@durable-actors/core/testing"
import {
  Clock,
  Config,
  Console,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Schedule,
  Scope,
} from "effect"
import { FetchHttpClient } from "effect/http"
import type { Pool } from "pg"
import { afterAll, expect, it } from "vitest"
import {
  endpoint,
  freePort,
  open,
  query,
  synchronousPair,
  until,
} from "../../../../packages/durable-actors/src/testing/conformance/crash/drills/failover.ts"
import { makeLoad, readiness, refusal, type Sent } from "./client.ts"
import { deploy, type Deployment, providerCalls } from "./deployment.ts"

const runtime = ManagedRuntime.make(
  Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer),
)

afterAll(() => runtime.dispose())

/** The chat room's rows in one database, counted by three independent tables. */
const audit = Effect.fnUntraced(function* (pool: Pool) {
  const [counts] = yield* query<{ receipts: number; messages: number; events: number }>(
    pool,
    `SELECT
      (SELECT count(DISTINCT command_id)::int FROM actor_receipts WHERE command = 'Post') AS receipts,
      (SELECT count(DISTINCT id)::int FROM chat_messages) AS messages,
      (SELECT count(DISTINCT command_id)::int FROM actor_events WHERE event = 'MessagePosted') AS events`,
  )

  const [duplicates] = yield* query<{ count: number }>(
    pool,
    `SELECT count(*)::int AS count FROM (
      SELECT command_id FROM actor_events WHERE event = 'MessagePosted'
      GROUP BY command_id HAVING count(*) > 1) repeated`,
  )

  const ids = yield* query<{ command_id: string }>(
    pool,
    "SELECT DISTINCT command_id FROM actor_receipts WHERE command = 'Post'",
  )

  return { ...counts!, repeated: duplicates!.count, ids: new Set(ids.map((row) => row.command_id)) }
})

/**
 * Whether no job is unsettled and no intent is due. Each post leaves its
 * room's 24 hour idle check pending, so the outbox itself is never empty. A
 * row claimed by a runner that lost its connection in the failover or drain
 * is due again only once its claim lease ends, up to a minute later, so the
 * waits on this allow three.
 */
const nothingDue = (pool: Pool) =>
  query<{ count: number }>(
    pool,
    `SELECT count(*)::int AS count FROM actor_outbox
      WHERE kind = 'job' OR scheduled_at_ms <= (extract(epoch FROM now()) * 1000)::bigint`,
  ).pipe(Effect.map((rows) => rows[0]!.count === 0))

/** Provider calls to the moderation stand-in for `message`, by its unique body. */
const callsFor = (message: Sent) => providerCalls.filter(({ body }) => body === message.body).length

/** The distinct idempotency keys the provider saw for `message`. */
const keysFor = (message: Sent) =>
  new Set(providerCalls.filter(({ body }) => body === message.body).map(({ key }) => key)).size

/**
 * The rehearsal starts its own Postgres primary and synchronous standby in
 * Docker and runs three runners, so it skips where the chat tests run on PGlite.
 */
const pglite = runtime.runSync(Config.String("TEST_BACKEND")) === "pglite"

it.skipIf(pglite)(
  "operates the served chat room through a drain, a Postgres failover, and a restore with no command lost or repeated",
  () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const pair = yield* synchronousPair("rehearsal")
        const proxyPort = yield* freePort
        const database = yield* endpoint(proxyPort, pair.primaryPort)

        const url = (port: number, name: string) =>
          Redacted.make(`postgres://project@127.0.0.1:${port}/${name}`)

        const routed = url(proxyPort, "rehearsal")
        const admin = yield* open(pair.standbyPort, "postgres")

        let current: Deployment = yield* deploy(routed)
        const load = yield* makeLoad({ current: () => current, label: "first" })

        yield* Console.error("REHEARSAL 1 deploy")

        for (const { port } of current.ports())
          expect(yield* readiness(port)).toEqual({ status: 200, reason: undefined })

        const clients = yield* load.clients(6, 12)
        yield* load.untilMore(60)

        yield* Console.error("REHEARSAL 2 drain a runner under load")

        const inFlightAtDrain = load.order.filter(({ ackedAt }) => ackedAt === undefined).length
        const beforeDrain = load.acknowledged()
        const drainedAt = yield* Clock.currentTimeMillis

        const report = yield* current.cluster.on(0)(
          RuntimeControl.use((control) => control.drain({ deadline: "20 seconds" })),
        )

        const drainMs = (yield* Clock.currentTimeMillis) - drainedAt
        const [drained] = current.ports().filter(({ runner }) => runner === 0)
        const whileDrained = yield* readiness(drained!.port)

        expect(whileDrained.status).toBe(503)
        expect(["draining", "drained"]).toContain(whileDrained.reason)

        yield* current.unlisten(0)
        yield* current.cluster.shutdown(0)
        yield* load.untilMore(60)
        yield* current.cluster.restart(0)
        yield* current.cluster.ready
        yield* current.listen(0)
        yield* load.untilMore(30)

        const ackedThroughDrain = load.acknowledged() - beforeDrain

        yield* Console.error("REHEARSAL 3 fail over the Postgres primary")

        const primaryScope = yield* Scope.make()
        const primary = yield* open(pair.primaryPort, "rehearsal").pipe(Scope.provide(primaryScope))

        const committed = query<{ command_id: string }>(
          primary,
          "SELECT command_id FROM actor_receipts WHERE command = 'Post'",
        ).pipe(Effect.map((rows) => rows.map(({ command_id }) => command_id)))

        const acknowledgedIds = () =>
          new Set(load.order.filter(({ ackedAt }) => ackedAt !== undefined).map(({ id }) => id))

        const commitUnknown = yield* Effect.gen(function* () {
          yield* database.hold

          const found = yield* Effect.gen(function* () {
            while (true) {
              const heard = acknowledgedIds()
              const pending = (yield* committed).filter((id) => !heard.has(id))

              if (pending.length > 0) return pending

              yield* Effect.sleep("20 millis")
            }
          }).pipe(Effect.timeoutOption("400 millis"))

          if (Option.isSome(found)) return found.value

          yield* database.release
          yield* Effect.sleep("200 millis")

          return yield* Effect.fail("no commit in flight")
        }).pipe(Effect.retry({ times: 50 }), Effect.orDie)

        const visibleBefore = yield* committed
        const killedAt = yield* Clock.currentTimeMillis
        yield* pair.kill
        yield* database.sever
        expect(yield* pair.promote).toBe(true)
        const promotedAt = yield* Clock.currentTimeMillis
        yield* database.route(pair.standbyPort)

        yield* load.untilMore(60)

        const afterKill = load.order.filter(
          ({ ackedAt }) => ackedAt !== undefined && ackedAt >= killedAt,
        )

        const recoveryMs = Math.min(...afterKill.map(({ ackedAt }) => ackedAt!)) - killedAt

        const worstMs = Math.max(
          ...load.order.map(({ ackedAt, startedAt }) => (ackedAt ?? startedAt) - startedAt),
        )

        yield* load.stop
        yield* Fiber.join(clients)

        const promotedScope = yield* Scope.make()

        const promoted = yield* open(pair.standbyPort, "rehearsal").pipe(
          Scope.provide(promotedScope),
        )

        yield* until(nothingDue(promoted), "no job or intent to be due", "180 seconds")

        const beforeBackup = yield* audit(promoted)
        const phaseOne = [...load.order]

        expect(phaseOne.filter(({ refused }) => refused !== undefined)).toEqual([])
        expect(phaseOne.every(({ ackedAt }) => ackedAt !== undefined)).toBe(true)
        expect(commitUnknown.every((id) => acknowledgedIds().has(id))).toBe(true)
        expect([...acknowledgedIds()].filter((id) => !beforeBackup.ids.has(id))).toEqual([])
        expect(visibleBefore.filter((id) => !beforeBackup.ids.has(id))).toEqual([])
        expect(beforeBackup).toMatchObject({
          receipts: phaseOne.length,
          messages: phaseOne.length,
          events: phaseOne.length,
          repeated: 0,
        })

        yield* Console.error("REHEARSAL 4 back up, keep serving, then restore")

        yield* current.close

        yield* Scope.close(primaryScope, Exit.void)
        yield* Scope.close(promotedScope, Exit.void)

        yield* Effect.tryPromise(() =>
          admin.query('CREATE DATABASE "backup" TEMPLATE "rehearsal"'),
        ).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("100 millis") }), Effect.orDie)

        current = yield* deploy(routed)
        const second = yield* makeLoad({ current: () => current, label: "second" })
        const secondClients = yield* second.clients(6, 12)
        yield* second.untilMore(40)
        yield* second.stop
        yield* Fiber.join(secondClients)

        const lastScope = yield* Scope.make()
        const lastState = yield* open(pair.standbyPort, "rehearsal").pipe(Scope.provide(lastScope))
        yield* until(nothingDue(lastState), "no job or intent to be due", "180 seconds")
        const beforeRestore = yield* audit(lastState)
        const phaseTwo = [...second.order]
        yield* Scope.close(lastScope, Exit.void)

        const callsBeforeRestore = new Map(
          [...phaseOne, ...phaseTwo].map((message) => [message.id, callsFor(message)] as const),
        )

        yield* current.close

        expect(beforeRestore).toMatchObject({
          receipts: phaseOne.length + phaseTwo.length,
          messages: phaseOne.length + phaseTwo.length,
          repeated: 0,
        })

        const restoredUrl = url(pair.standbyPort, "backup")
        current = yield* deploy(restoredUrl)
        const restored = yield* open(pair.standbyPort, "backup")
        const atBackup = yield* audit(restored)

        expect(atBackup).toMatchObject({
          receipts: phaseOne.length,
          messages: phaseOne.length,
          events: phaseOne.length,
          repeated: 0,
        })

        const everything = [...phaseOne, ...phaseTwo]
        const retried = new Map<string, number | undefined>()
        const resender = yield* makeLoad({ current: () => current, label: "resend" })

        for (const message of everything) {
          const reply = yield* resender.resend(message)
          retried.set(message.id, reply.status)
        }

        yield* until(nothingDue(restored), "no restored job or intent to be due", "180 seconds")
        const afterRetry = yield* audit(restored)

        expect([...retried.values()].every((status) => status === 200)).toBe(true)
        expect(afterRetry).toMatchObject({
          receipts: everything.length,
          messages: everything.length,
          events: everything.length,
          repeated: 0,
        })
        expect([...afterRetry.ids].sort()).toEqual(everything.map(({ id }) => id).sort())

        const reRun = phaseTwo.filter(
          (message) => callsFor(message) > callsBeforeRestore.get(message.id)!,
        )

        expect(reRun.length).toBe(phaseTwo.length)
        expect(
          phaseOne.filter((message) => callsFor(message) !== callsBeforeRestore.get(message.id)),
        ).toEqual([])

        for (const runner of [0, 1, 2])
          yield* current.cluster.on(runner)(ActorTest.use((test) => test.advance("2 days")))

        const expired = new Set<string | undefined>()

        for (const message of everything) {
          const reply = yield* resender.resend(message)
          expired.add(reply.status === 200 ? "accepted" : refusal(reply))
        }

        expect([...expired]).toEqual(["CommandExpired"])
        expect(yield* audit(restored)).toMatchObject({
          receipts: everything.length,
          messages: everything.length,
          repeated: 0,
        })

        yield* current.close

        const providerRepeats = phaseOne.filter((message) => callsFor(message) > 1).length

        expect(phaseOne.filter((message) => keysFor(message) !== 1)).toEqual([])

        yield* Console.error(
          `REHEARSAL phaseOne=${phaseOne.length} phaseTwo=${phaseTwo.length} ` +
            `drain=${report.outcome} drainMs=${drainMs} interruptedTurns=${report.interruptedTurns} ` +
            `interruptedJobs=${report.interruptedJobs} inFlightAtDrain=${inFlightAtDrain} ackedThroughDrain=${ackedThroughDrain} ` +
            `commitUnknown=${commitUnknown.length} promoteMs=${promotedAt - killedAt} recoveryMs=${recoveryMs} worstCommandMs=${worstMs} ` +
            `atBackup=${atBackup.receipts} rerunAfterRestore=${reRun.length} providerRepeatsPhaseOne=${providerRepeats} ` +
            `lost=0 repeated=${afterRetry.repeated}`,
        )
      }).pipe(Effect.scoped, Effect.timeout("14 minutes")),
    ),
  900_000,
)
