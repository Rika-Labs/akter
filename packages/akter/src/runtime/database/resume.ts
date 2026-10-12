import { connect } from "node:net"
import type { PgPool } from "@effect/sql-pg"
import type { ClusterError } from "effect/cluster"
import { Cause, Clock, Context, Deferred, Effect, Fiber, Layer, Redacted, Schedule } from "effect"
import type { Scope } from "effect"
import { clockDiscontinuous, ClockReadings } from "../clock.ts"

/** One runtime's connection epoch and post-resume ownership gate, shared by all its pools. */
export class ResumeEpoch extends Context.Service<
  ResumeEpoch,
  {
    readonly check: () => number
    readonly ready: () => boolean
    readonly settled: Effect.Effect<void>
    readonly track: (options: PgPool.Config) => PgPool.Config
    readonly recover: (
      reacquire: Effect.Effect<boolean, ClusterError.PersistenceError>,
    ) => Effect.Effect<void, never, Scope.Scope>
  }
>()("@rikalabs/akter/runtime/database/resume/ResumeEpoch") {}

/** Owns factory-created sockets, preserving the driver's TLS negotiation and supplied factories. */
export const resumeEpoch = Effect.gen(function* () {
  const clock = yield* Clock.Clock
  const read = yield* ClockReadings
  const runFork = Effect.runForkWith(yield* Effect.context<never>())
  let baseline = read(clock)
  let epoch = 0
  let recovered = 0
  let closed: Deferred.Deferred<void> | undefined
  let recovering: Fiber.Fiber<void> | undefined
  let shuttingDown = false
  const sockets = new Map<ReturnType<NonNullable<PgPool.Config["stream"]>>, number>()
  const recoveries = new Set<Effect.Effect<boolean, ClusterError.PersistenceError>>()

  const settled: Effect.Effect<void> = Effect.suspend(() => {
    check()
    const barrier = closed
    return barrier === undefined
      ? Effect.void
      : Deferred.await(barrier).pipe(
          Effect.andThen(Effect.suspend(() => (barrier === closed ? Effect.void : settled))),
        )
  })

  const recover = Effect.gen(function* () {
    const target = epoch
    yield* settled
    if (recoveries.size === 0) return
    const checked = yield* Effect.forEach(recoveries, (reacquire) =>
      reacquire.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(false),
        ),
      ),
    )
    if (target === epoch && checked.every(Boolean)) recovered = target
  }).pipe(
    Effect.repeat({ schedule: Schedule.spaced("1 second"), until: () => recovered === epoch }),
  )

  const check = () => {
    if (shuttingDown) return epoch
    const next = read(clock)
    if (!clockDiscontinuous({ before: baseline, after: next })) return epoch
    baseline = next
    epoch++
    closed = Deferred.makeUnsafe<void>()
    const barrier = closed
    const stale = Array.from(sockets).filter(([, created]) => created < epoch)
    let remaining = stale.length
    if (remaining === 0) Deferred.doneUnsafe(barrier, Effect.void)
    for (const [socket] of stale)
      socket.once("close", () => {
        if (--remaining === 0) setImmediate(() => Deferred.doneUnsafe(barrier, Effect.void))
      })
    for (const [socket] of stale) socket.destroy()
    recovering?.interruptUnsafe()
    recovering = runFork(recover)
    return epoch
  }

  yield* Effect.sync(check).pipe(Effect.delay("1 second"), Effect.forever, Effect.forkScoped)
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      shuttingDown = true
      return recovering === undefined ? Effect.void : Fiber.interrupt(recovering)
    }),
  )

  return ResumeEpoch.of({
    check,
    ready: () => {
      check()
      return epoch === recovered
    },
    settled,
    track: (options) => ({
      ...options,
      stream: () => {
        check()
        const url = options.url === undefined ? undefined : new URL(Redacted.value(options.url))
        const hostname = url?.hostname
        const host =
          options.host ??
          url?.searchParams.get("host") ??
          (hostname === undefined || hostname === ""
            ? "localhost"
            : hostname.startsWith("[")
              ? hostname.slice(1, -1)
              : decodeURIComponent(hostname))
        const port = options.port ?? Number((url?.searchParams.get("port") ?? url?.port) || 5432)
        const path = options.path ?? (host.startsWith("/") ? `${host}/.s.PGSQL.${port}` : undefined)
        const socket =
          options.stream?.() ??
          (path === undefined ? connect({ host, port, noDelay: true }) : connect({ path }))
        sockets.set(socket, epoch)
        socket.once("close", () => sockets.delete(socket))
        return socket
      },
    }),
    recover: (reacquire) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          recoveries.add(reacquire)
        }),
        () => Effect.sync(() => recoveries.delete(reacquire)),
      ),
  })
})

/** One shared registry rather than one detector and reset per pool. */
export const resumeEpochLayer = Layer.effect(ResumeEpoch, resumeEpoch)
