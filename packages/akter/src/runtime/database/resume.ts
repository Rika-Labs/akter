import { connect } from "node:net"
import { NodeCrypto } from "@effect/platform-node-shared"
import { PgConnection, PgTypes, type PgClient, type PgPool } from "@effect/sql-pg"
import type { ClusterError } from "effect/cluster"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect"
import type { Scope } from "effect"
import { clockDiscontinuous, ClockReadings } from "../clock.ts"

type Socket = ReturnType<NonNullable<PgPool.Config["stream"]>>

interface Session {
  readonly socket: Socket
  readonly epoch: number
}

interface Sessions {
  readonly options: PgPool.Config
  readonly sockets: Map<Socket, Session>
  readonly pids: Map<number, number>
  readonly lost: Set<number>
  addresses?: () => ReadonlyArray<string>
  leases?: () => ReadonlyArray<{ readonly address: string; readonly shard: string }>
  expiration?: number
}

/** One runtime's public connection identities, socket epoch and ownership recovery gate. */
export class ResumeEpoch extends Context.Service<
  ResumeEpoch,
  {
    readonly check: () => number
    readonly ready: () => boolean
    readonly verified: () => boolean
    readonly settled: Effect.Effect<void>
    readonly changed: () => void
    readonly requireReacquisition: () => void
    readonly authority: (
      options: PgClient.PgClientConfig,
      addresses: () => ReadonlyArray<string>,
      leases?: () => ReadonlyArray<{ readonly address: string; readonly shard: string }>,
      expiration?: number,
    ) => Effect.Effect<void, never, Scope.Scope>
    readonly track: (options: PgPool.Config) => PgPool.Config
    readonly observe: (
      options: PgPool.Config,
      connection: PgConnection.PgConnection,
    ) => Effect.Effect<void, never, Scope.Scope>
    readonly recover: (
      reacquire: Effect.Effect<boolean, ClusterError.PersistenceError>,
    ) => Effect.Effect<void, never, Scope.Scope>
  }
>()("@rikalabs/akter/runtime/database/resume/ResumeEpoch") {}

/** A public stream factory leaves TLS negotiation and certificate verification with the driver. */
const streamOf = (options: PgPool.Config): Socket => {
  if (options.stream !== undefined) return options.stream()
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
  return path === undefined ? connect({ host, port, noDelay: true }) : connect({ path })
}

/** Verifies retained direct sessions before replacing them; unsupported or ambiguous identities fail closed. */
export const resumeEpoch = Effect.gen(function* () {
  const clock = yield* Clock.Clock
  const read = yield* ClockReadings
  const runFork = Effect.runForkWith(yield* Effect.context<never>())
  const name = `akter/${yield* NodeCrypto.make.randomUUIDv4().pipe(Effect.orDie)}`
  const tracked = new Map<PgPool.Config, Sessions>()
  const recoveries = new Set<Effect.Effect<boolean, ClusterError.PersistenceError>>()
  let baseline = read(clock)
  let epoch = 0
  let recovered = 0
  let verifying = false
  let verifiedAt = -Infinity
  let closed: Deferred.Deferred<void> | undefined
  let changed: Deferred.Deferred<void> | undefined
  let checking: Fiber.Fiber<void> | undefined
  let shuttingDown = false
  let retentionAllowed = true

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
    while (recovered !== epoch) {
      const target = epoch
      changed = Deferred.makeUnsafe<void>()
      yield* settled
      if (recoveries.size > 0) {
        const checked = yield* Effect.forEach(recoveries, (reacquire) =>
          reacquire.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(false),
            ),
          ),
        )
        if (target === epoch && checked.every(Boolean)) recovered = target
      }
      if (recovered !== epoch) yield* Deferred.await(changed).pipe(Effect.timeoutOption("1 second"))
    }
  })

  const verify = Effect.gen(function* () {
    if (!retentionAllowed) return false
    const groups = new Map<
      string,
      {
        options: PgPool.Config
        sessions: ReadonlyArray<Session>
        pids: ReadonlyArray<number>
        addresses: ReadonlyArray<string>
        leases?: ReadonlyArray<{ readonly address: string; readonly shard: string }>
        expiration?: number
      }
    >()
    for (const pool of tracked.values()) {
      const sessions = Array.from(pool.sockets.values())
      const { url, host, port, path, username, database, applicationName } = pool.options
      const key = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
        url === undefined ? undefined : Redacted.value(url),
        host,
        port,
        path,
        username,
        database,
        applicationName,
      ]).pipe(Effect.orDie)
      const previous = groups.get(key)
      groups.set(key, {
        options: pool.options,
        sessions: [...(previous?.sessions ?? []), ...sessions],
        pids: [...(previous?.pids ?? []), ...pool.pids.keys(), ...pool.lost],
        addresses: [...(previous?.addresses ?? []), ...(pool.addresses?.() ?? [])],
        leases: pool.leases?.() ?? previous?.leases,
        expiration: pool.expiration ?? previous?.expiration,
      })
    }
    const checked = yield* Effect.forEach(
      groups.values(),
      ({ options, sessions, pids, addresses: registered, leases, expiration }) =>
        Effect.gen(function* () {
          const addresses = Array.from(new Set(registered))
          const expected = Array.from(new Set(pids))
          const sockets = new Set<Socket>()
          const healthy = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.sleep("1500 millis").pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    for (const socket of sockets) socket.destroy()
                  }),
                ),
                Effect.forkScoped,
              )
              return yield* Effect.gen(function* () {
                const connection = yield* PgConnection.make({
                  ...options,
                  applicationName: `${name}/verify`,
                  connectTimeout: "1500 millis",
                  stream: () => {
                    const socket = streamOf(options)
                    sockets.add(socket)
                    return socket
                  },
                })
                const tableLeases =
                  leases === undefined
                    ? []
                    : [
                        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(leases),
                        expiration,
                      ]
                const rows = yield* connection.queryValues(
                  addresses.length === 0
                    ? "SELECT pg_backend_pid()::integer, count(*)::integer, count(*) FILTER (WHERE pid = ANY($1::integer[]))::integer FROM pg_stat_activity WHERE datname = current_database() AND usename = session_user AND application_name = $2 AND pid <> pg_backend_pid()"
                    : `WITH live AS (SELECT pg_backend_pid()::integer AS current_pid, count(*)::integer AS sessions,
               count(*) FILTER (WHERE pid = ANY($1::integer[]))::integer AS held FROM pg_stat_activity
               WHERE datname = current_database() AND usename = session_user AND application_name = $2 AND pid <> pg_backend_pid()),
             ${leases === undefined ? "" : "required AS (SELECT * FROM jsonb_to_recordset($7::jsonb) AS r(address text, shard text)),"}
             renewed AS (UPDATE cluster_runners SET last_heartbeat = NOW() WHERE address = ANY($3::text[])
               AND (SELECT sessions = $4 AND held = $5 AND current_pid = $6 FROM live)
               ${leases === undefined ? "" : "AND NOT EXISTS (SELECT 1 FROM required r LEFT JOIN cluster_locks l ON l.shard_id = r.shard AND l.address = r.address WHERE l.shard_id IS NULL OR l.acquired_at < NOW() - make_interval(secs => $8))"}
               RETURNING address)
             SELECT current_pid, sessions, held, (SELECT count(*)::integer FROM renewed) FROM live`,
                  addresses.length === 0
                    ? [
                        Result.getOrThrow(PgTypes.array(expected, PgTypes.OID.int4)),
                        options.applicationName,
                      ]
                    : [
                        Result.getOrThrow(PgTypes.array(expected, PgTypes.OID.int4)),
                        options.applicationName,
                        addresses,
                        sessions.length,
                        expected.length,
                        connection.processId,
                        ...tableLeases,
                      ],
                  false,
                )
                return (
                  Number(rows[0]?.[0]) === connection.processId &&
                  Number(rows[0]?.[1]) === sessions.length &&
                  Number(rows[0]?.[2]) === expected.length &&
                  (addresses.length === 0 || Number(rows[0]?.[3]) === addresses.length)
                )
              }).pipe(
                Effect.timeoutOption("1500 millis"),
                Effect.map(Option.getOrElse(() => false)),
                Effect.ensuring(
                  Effect.sync(() => {
                    for (const socket of sockets) socket.destroy()
                  }),
                ),
              )
            }),
          ).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(false),
            ),
          )
          return healthy && !sessions.some((session) => session.socket.destroyed)
        }),
      { concurrency: "unbounded" },
    )
    return checked.every(Boolean)
  })

  const check = () => {
    if (shuttingDown) return epoch
    const next = read(clock)
    if (!clockDiscontinuous({ before: baseline, after: next })) return epoch
    baseline = next
    checking?.interruptUnsafe()
    const previous = closed
    closed = Deferred.makeUnsafe<void>()
    const barrier = closed
    if (previous !== undefined) Deferred.doneUnsafe(previous, Effect.void)
    verifying = true
    verifiedAt = -Infinity
    checking = runFork(
      Effect.gen(function* () {
        const healthy = yield* verify
        if (barrier !== closed) return
        verifying = false
        if (healthy) {
          verifiedAt = read(clock).at
          Deferred.doneUnsafe(barrier, Effect.void)
          if (recovered !== epoch) yield* recover
          return
        }
        epoch++
        for (const pool of tracked.values()) {
          pool.pids.clear()
          pool.lost.clear()
        }
        const stale = Array.from(tracked.values())
          .flatMap((pool) => Array.from(pool.sockets.values()))
          .filter((session) => session.epoch < epoch)
        let remaining = stale.length
        if (remaining === 0) Deferred.doneUnsafe(barrier, Effect.void)
        for (const { socket } of stale)
          socket.once("close", () => {
            if (--remaining === 0) setImmediate(() => Deferred.doneUnsafe(barrier, Effect.void))
          })
        for (const { socket } of stale) socket.destroy()
        yield* recover
      }),
    )
    return epoch
  }

  yield* Effect.sync(check).pipe(Effect.delay("1 second"), Effect.forever, Effect.forkScoped)
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      shuttingDown = true
      return checking === undefined ? Effect.void : Fiber.interrupt(checking)
    }),
  )

  return ResumeEpoch.of({
    check,
    ready: () => {
      check()
      return !verifying && epoch === recovered
    },
    verified: () => !verifying && epoch === recovered && read(clock).at - verifiedAt < 1_000,
    settled,
    requireReacquisition: () => {
      retentionAllowed = false
    },
    authority: (options, addresses, leases, expiration) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const pool = Array.from(tracked).find(([candidate]) => candidate === options)?.[1]
          if (pool !== undefined) {
            pool.addresses = addresses
            pool.leases = leases
            pool.expiration = expiration
          }
          return pool
        }),
        (pool) =>
          Effect.sync(() => {
            if (pool !== undefined) {
              pool.addresses = undefined
              pool.leases = undefined
              pool.expiration = undefined
            }
          }),
      ),
    changed: () => {
      if (changed !== undefined && recovered !== epoch) Deferred.doneUnsafe(changed, Effect.void)
    },
    track: (options) => {
      const url = options.url === undefined ? undefined : new URL(Redacted.value(options.url))
      const named = Object.entries(options.startupParameters ?? {}).find(
        ([key]) => key.toLowerCase() === "application_name",
      )?.[1]
      const letters = Array.from(
        options.applicationName ??
          named ??
          url?.searchParams.getAll("application_name").at(-1) ??
          name,
      )
      while (new TextEncoder().encode(letters.join("")).length > 63) letters.pop()
      const config = { ...options, applicationName: letters.join("") }
      const pool: Sessions = tracked.get(options) ?? {
        options: config,
        sockets: new Map(),
        pids: new Map(),
        lost: new Set(),
      }
      tracked.set(options, pool)
      return {
        ...config,
        stream: () => {
          check()
          const socket = streamOf(options)
          const session: Session = { socket, epoch }
          pool.sockets.set(socket, session)
          socket.once("close", () => {
            if (session.epoch === epoch) for (const pid of pool.pids.keys()) pool.lost.add(pid)
            pool.sockets.delete(socket)
          })
          return socket
        },
      }
    },
    observe: (options, connection) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const pool = tracked.get(options)
          if (pool === undefined) return undefined
          pool.pids.set(connection.processId, (pool.pids.get(connection.processId) ?? 0) + 1)
          return { pool, started: epoch }
        }),
        (observed) =>
          Effect.sync(() => {
            if (observed === undefined || observed.started !== epoch) return
            const { pool } = observed
            const count = (pool.pids.get(connection.processId) ?? 1) - 1
            if (count === 0) pool.pids.delete(connection.processId)
            else pool.pids.set(connection.processId, count)
          }),
      ),
    recover: (reacquire) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          recoveries.add(reacquire)
        }),
        () => Effect.sync(() => recoveries.delete(reacquire)),
      ),
  })
})

/** One shared registry rather than a verification and reset per pool. */
export const resumeEpochLayer = Layer.effect(ResumeEpoch, resumeEpoch)
