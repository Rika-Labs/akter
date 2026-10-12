import { Clock, Duration, Effect, Layer, Option, Random, Schema } from "effect"
import { PersistenceError } from "effect/cluster/ClusterError"
import * as RunnerStorage from "effect/cluster/RunnerStorage"
import * as ShardingConfig from "effect/cluster/ShardingConfig"
import { Store } from "./service.ts"

/**
 * Cluster timing on a bucket: a shard lock expires after 30 seconds without
 * a heartbeat and assignments are re-read every 15 seconds, sized for object
 * store write latency and per-key write limits rather than a database's.
 */
export const runnerDefaults = {
  shardLockExpiration: Duration.seconds(30),
  refreshAssignmentsInterval: Duration.seconds(15),
} satisfies Partial<ShardingConfig.ShardingConfig["Service"]>

/** Machine ids Effect Cluster's snowflakes can carry. */
const MACHINE_IDS = 1024

/** Floor between two heartbeats of one runner, the per-key write rate some buckets enforce. */
const BEAT_FLOOR_MILLIS = 1000

const RUNNERS = "cluster/runners/"
const BEATS = "cluster/beats/"
const LOCKS = "cluster/locks/"
const MACHINES = "cluster/machines/"

const Registration = Schema.Struct({
  format: Schema.Literal(1),
  runner: Schema.String,
  healthy: Schema.Boolean,
  machineId: Schema.Int,
  nonce: Schema.String,
})

const Owner = Schema.Struct({
  format: Schema.Literal(1),
  address: Schema.NullOr(Schema.String),
  nonce: Schema.String,
})

const RegistrationJson = Schema.fromJsonString(Registration)
const OwnerJson = Schema.fromJsonString(Owner)

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const now = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos / 1_000_000n))

const refail = <A, E, R>(effect: Effect.Effect<A, E, R>) => PersistenceError.refail(effect)

/**
 * Effect Cluster's runner storage on the store's lease objects:
 *
 * - `cluster/runners/<address>`: registration `{ runner, healthy, machineId }`
 * - `cluster/beats/<address>`: heartbeat, rewritten on every refresh
 * - `cluster/locks/<shard>`: `{ address }`, or `{ address: null }` once released
 * - `cluster/machines/<n>`: `{ address }`, a claim on snowflake machine id `n`
 *
 * Liveness is observed, never computed from wall clocks: a runner is live
 * while the etag of its heartbeat changed within `shardLockExpiration` on the
 * observer's monotonic clock. A missing lock is created once; a released lock,
 * or one whose owner is not live, is taken by compare-and-swap on its etag, so
 * two contenders never both win. Shard assignment is computed by every runner
 * from the live runners, so no assignment object exists. A paused owner can
 * still believe it holds a lock it lost; the log's fence, not this lock, is
 * what keeps it from writing. Every body carries a nonce, so a rewritten body
 * never repeats an etag a contender saw before.
 */
export const runnerStorage = Effect.gen(function* () {
  const store = yield* Store
  const leases = store.leases
  const config = yield* ShardingConfig.ShardingConfig
  const expiration = Duration.toMillis(Duration.fromInputUnsafe(config.shardLockExpiration))
  const instance = `${(yield* Random.nextIntBetween(0, 0xffff_ffff)).toString(36)}${(yield* Random.nextIntBetween(0, 0xffff_ffff)).toString(36)}`
  let writes = 0
  const nonce = () => {
    writes += 1
    return `${instance}-${writes}`
  }

  const beats = new Map<string, { readonly etag: string; readonly since: number }>()
  let beatsListedAt = Number.NEGATIVE_INFINITY
  const registrations = new Map<
    string,
    { readonly etag: string; readonly runner: string; readonly healthy: boolean }
  >()
  const lockOwners = new Map<string, string | null>()
  const held = new Map<string, string>()
  const lastBeat = new Map<string, number>()

  const keyOf = (prefix: string, name: string) => `${prefix}${encodeURIComponent(name)}`
  const nameOf = (prefix: string, key: string) => decodeURIComponent(key.slice(prefix.length))

  const ownerBody = (address: string | null) =>
    Schema.encodeEffect(OwnerJson)({ format: 1, address, nonce: nonce() }).pipe(
      Effect.map((json) => encoder.encode(json)),
      Effect.orDie,
    )
  const readOwner = (body: Uint8Array) =>
    Schema.decodeEffect(OwnerJson)(decoder.decode(body)).pipe(Effect.orDie)

  const observeBeats = Effect.gen(function* () {
    const listed = yield* leases.list(BEATS)
    const at = yield* now
    const seen = new Set<string>()
    for (const item of listed) {
      const address = nameOf(BEATS, item.key)
      seen.add(address)
      const previous = beats.get(address)
      if (previous === undefined || previous.etag !== item.etag)
        beats.set(address, { etag: item.etag, since: at })
    }
    for (const address of beats.keys()) if (!seen.has(address)) beats.delete(address)
    beatsListedAt = at
  })

  const isLive = (address: string, at: number) => {
    const beat = beats.get(address)
    return beat !== undefined && at - beat.since < expiration
  }

  /** The owner a lock's body names, if the lock still has the listed etag. */
  const ownerOf = (key: string, etag: string) =>
    Effect.gen(function* () {
      const cached = lockOwners.get(`${key} ${etag}`)
      if (cached !== undefined) return Option.some(cached)
      const object = yield* leases.read(key)
      if (Option.isNone(object)) return Option.none<string | null>()
      const owner = (yield* readOwner(object.value.body)).address
      lockOwners.set(`${key} ${object.value.etag}`, owner)
      return object.value.etag === etag ? Option.some(owner) : Option.none<string | null>()
    })

  const heartbeat = (address: string) =>
    Effect.gen(function* () {
      const at = yield* now
      if (at - (lastBeat.get(address) ?? Number.NEGATIVE_INFINITY) < BEAT_FLOOR_MILLIS) return
      yield* leases.write(keyOf(BEATS, address), yield* ownerBody(address))
      lastBeat.set(address, at)
    })

  const claimMachineId = (address: string) =>
    Effect.gen(function* () {
      let start = 0
      for (let index = 0; index < address.length; index++)
        start = (start * 31 + address.charCodeAt(index)) >>> 0
      for (let offset = 0; offset < MACHINE_IDS; offset++) {
        const id = (start + offset) % MACHINE_IDS
        const key = `${MACHINES}${id}`
        const existing = yield* leases.read(key)
        if (Option.isNone(existing)) {
          if (Option.isSome(yield* leases.create(key, yield* ownerBody(address)))) return id
          continue
        }
        const owner = (yield* readOwner(existing.value.body)).address
        if (owner === address) return id
        if (owner !== null && isLive(owner, yield* now)) continue
        if (
          Option.isSome(yield* leases.replace(key, yield* ownerBody(address), existing.value.etag))
        )
          return id
      }
      return yield* Effect.die(new Error("Every cluster machine id is claimed by a live runner"))
    })

  const writeLock = (shardId: string, owner: string | null, etag: Option.Option<string>) =>
    Effect.gen(function* () {
      const key = keyOf(LOCKS, shardId)
      const body = yield* ownerBody(owner)
      const written = yield* Option.match(etag, {
        onNone: () => leases.create(key, body),
        onSome: (current) => leases.replace(key, body, current),
      })
      if (Option.isSome(written)) lockOwners.set(`${key} ${written.value}`, owner)
      return written
    })

  const listLocks = Effect.map(
    leases.list(LOCKS),
    (items) => new Map(items.map((item) => [nameOf(LOCKS, item.key), item.etag])),
  )

  const releaseHeld = (shardId: string) =>
    Effect.gen(function* () {
      const etag = held.get(shardId)
      held.delete(shardId)
      if (etag !== undefined) yield* writeLock(shardId, null, Option.some(etag))
    })

  return RunnerStorage.makeEncoded({
    getRunners: Effect.gen(function* () {
      yield* observeBeats
      const at = yield* now
      const runners: Array<readonly [string, boolean]> = []
      const seen = new Set<string>()
      for (const item of yield* leases.list(RUNNERS)) {
        const address = nameOf(RUNNERS, item.key)
        seen.add(address)
        let registration = registrations.get(address)
        if (registration === undefined || registration.etag !== item.etag) {
          const object = yield* leases.read(item.key)
          if (Option.isNone(object)) continue
          const decoded = yield* Schema.decodeEffect(RegistrationJson)(
            decoder.decode(object.value.body),
          ).pipe(Effect.orDie)
          registration = {
            etag: object.value.etag,
            runner: decoded.runner,
            healthy: decoded.healthy,
          }
          registrations.set(address, registration)
        }
        if (isLive(address, at)) runners.push([registration.runner, registration.healthy])
      }
      for (const address of registrations.keys())
        if (!seen.has(address)) registrations.delete(address)
      return runners
    }).pipe(refail),

    register: (address, runner, healthy) =>
      Effect.gen(function* () {
        yield* observeBeats
        const machineId = yield* claimMachineId(address)
        const body = yield* Schema.encodeEffect(RegistrationJson)({
          format: 1,
          runner,
          healthy,
          machineId,
          nonce: nonce(),
        }).pipe(Effect.orDie)
        yield* leases.write(keyOf(RUNNERS, address), encoder.encode(body))
        lastBeat.delete(address)
        yield* heartbeat(address)
        return machineId
      }).pipe(refail),

    unregister: (address) =>
      Effect.gen(function* () {
        yield* leases.remove(keyOf(BEATS, address))
        yield* leases.remove(keyOf(RUNNERS, address))
      }).pipe(refail),

    setRunnerHealth: (address, healthy) =>
      Effect.gen(function* () {
        const key = keyOf(RUNNERS, address)
        const object = yield* leases.read(key)
        if (Option.isNone(object)) return
        const decoded = yield* Schema.decodeEffect(RegistrationJson)(
          decoder.decode(object.value.body),
        ).pipe(Effect.orDie)
        if (decoded.healthy === healthy) return
        const body = yield* Schema.encodeEffect(RegistrationJson)({
          ...decoded,
          healthy,
          nonce: nonce(),
        }).pipe(Effect.orDie)
        yield* leases.replace(key, encoder.encode(body), object.value.etag)
      }).pipe(refail),

    acquire: (address, shardIds) =>
      Effect.gen(function* () {
        if ((yield* now) - beatsListedAt > BEAT_FLOOR_MILLIS) yield* observeBeats
        const locks = yield* listLocks
        const at = yield* now
        const acquired: Array<string> = []
        for (const shardId of shardIds) {
          const etag = locks.get(shardId)
          if (etag === undefined) {
            const created = yield* writeLock(shardId, address, Option.none())
            if (Option.isSome(created)) {
              held.set(shardId, created.value)
              acquired.push(shardId)
            }
            continue
          }
          const owner = yield* ownerOf(keyOf(LOCKS, shardId), etag)
          if (Option.isNone(owner)) continue
          if (owner.value === address) {
            held.set(shardId, etag)
            acquired.push(shardId)
            continue
          }
          if (owner.value !== null && isLive(owner.value, at)) continue
          const taken = yield* writeLock(shardId, address, Option.some(etag))
          if (Option.isSome(taken)) {
            held.set(shardId, taken.value)
            acquired.push(shardId)
          }
        }
        return acquired
      }).pipe(refail),

    refresh: (address, shardIds) =>
      Effect.gen(function* () {
        yield* heartbeat(address)
        if (shardIds.length === 0) return []
        const locks = yield* listLocks
        const still: Array<string> = []
        for (const shardId of shardIds) {
          const etag = locks.get(shardId)
          if (etag === undefined) {
            held.delete(shardId)
            continue
          }
          if (held.get(shardId) === etag) {
            still.push(shardId)
            continue
          }
          const owner = yield* ownerOf(keyOf(LOCKS, shardId), etag)
          if (Option.contains(owner, address)) {
            held.set(shardId, etag)
            still.push(shardId)
          } else held.delete(shardId)
        }
        return still
      }).pipe(refail),

    release: (_address, shardId) => releaseHeld(shardId).pipe(refail),

    releaseAll: (address) =>
      Effect.gen(function* () {
        for (const [shardId, etag] of yield* listLocks) {
          if (!held.has(shardId)) {
            if (!Option.contains(yield* ownerOf(keyOf(LOCKS, shardId), etag), address)) continue
            held.set(shardId, etag)
          }
          yield* releaseHeld(shardId)
        }
      }).pipe(refail),
  })
})

/** Runner storage on the store's bucket, for Effect Cluster's `Sharding`. */
export const runnerStorageLayer: Layer.Layer<
  RunnerStorage.RunnerStorage,
  never,
  Store | ShardingConfig.ShardingConfig
> = Layer.effect(RunnerStorage.RunnerStorage, runnerStorage)
