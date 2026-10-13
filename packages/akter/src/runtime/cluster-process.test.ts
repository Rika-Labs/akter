import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3"
import {
  Clock,
  Config,
  Console,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Redacted,
  Result,
  Schema,
  Stream,
} from "effect"
import { describe, expect, it } from "@effect/vitest"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import type { Socket } from "node:net"
import { arch, hostname, platform } from "node:os"
import { fileURLToPath } from "node:url"
import {
  Autumn,
  Bulk,
  Call,
  ClockSet,
  Drain,
  Ledger,
  Mint,
  Options,
  Request,
  SHARDS,
  Spring,
  State,
  Status,
} from "../../../../tooling/conformance/src/fixtures/cluster.ts"
import { Durable } from "../execution/durable.ts"
import { Entry, EntryCodec, Origin } from "../execution/entries.ts"
import { RunnerAuthority } from "./peering/authority.ts"
import { s3Bucket } from "../store/s3.ts"
import { fileSystemBucket } from "../store/file-system.ts"
import { storeOf } from "../store/service.ts"
import { runnerDefaults } from "../store/runners.ts"
import { decodeManifest } from "../store/codec.ts"
import { checkpointPrefix } from "../store/keys.ts"
import { DrainReport as HostDrainReport } from "../runtime/drain.ts"

const script = fileURLToPath(
  new URL("../../../../tooling/conformance/src/fixtures/cluster-runner.ts", import.meta.url),
)
const pause = (milliseconds: number) => Effect.sleep(milliseconds)
let run = 0

class FixtureFailure extends Schema.TaggedError<FixtureFailure>()("FixtureFailure", {
  reason: Schema.String,
}) {}

const port = Effect.gen(function* () {
  const { createServer } = yield* Effect.promise(() => import("node:net"))
  const server = createServer()
  yield* Effect.callback<void>((resume) => {
    server.listen(0, "127.0.0.1", () => resume(Effect.void))
  })
  const parsed = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
    server.address(),
  )
  yield* Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void))
  })
  return parsed.port
})

/** A byte-preserving TCP fault boundary: certificates and peer RPC remain production implementations. */
const proxy = Effect.fnUntraced(function* (target: number) {
  const { connect, createServer } = yield* Effect.promise(() => import("node:net"))
  const sockets = new Set<Socket>()
  let blocked = false
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createServer((incoming) => {
        if (blocked) {
          incoming.destroy()
          return
        }
        const outgoing = connect(target, "127.0.0.1")
        for (const socket of [incoming, outgoing]) {
          sockets.add(socket)
          socket.on("error", () => {
            incoming.destroy()
            outgoing.destroy()
          })
          socket.on("close", () => sockets.delete(socket))
        }
        incoming.pipe(outgoing)
        outgoing.pipe(incoming)
      }),
    ),
    (opened) =>
      Effect.callback<void>((resume) => {
        for (const socket of sockets) socket.destroy()
        opened.close(() => resume(Effect.void))
      }),
  )
  yield* Effect.callback<void>((resume) => {
    server.listen(0, "127.0.0.1", () => resume(Effect.void))
  })
  const advertised = (yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
    server.address(),
  )).port
  return {
    advertised,
    partition: (value: boolean) => {
      blocked = value
      if (value) for (const socket of sockets) socket.destroy()
    },
  }
})

const spawn = Effect.fnUntraced(function* (env: Readonly<Record<string, string>>) {
  const { spawn } = yield* Effect.promise(() => import("node:child_process"))
  return spawn(process.execPath, [script], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
})
type Child = Effect.Success<ReturnType<typeof spawn>>
const stop = (child: Child) =>
  Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.void)
      return
    }
    child.kill("SIGCONT")
    child.once("exit", () => resume(Effect.void))
    child.kill("SIGKILL")
  })
interface Runner {
  readonly child: Child
  readonly control: number
  readonly writer: string
  readonly proxy: Effect.Success<ReturnType<typeof proxy>>
  readonly stop: () => Effect.Effect<void>
  readonly signalDrain: () => Effect.Effect<
    HostDrainReport,
    Schema.SchemaError | import("effect").Cause.TimeoutError
  >
}

const request = <A>(
  runner: Runner,
  body: typeof Request.Type,
  schema: Schema.Codec<A>,
  timeout = 20_000,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(
      HttpClientRequest.post(`http://127.0.0.1:${runner.control}/`).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    )
    if (response.status !== 200)
      return yield* FixtureFailure.make({ reason: `Fixture control returned ${response.status}` })
    return yield* Schema.decodeUnknownEffect(schema)(yield* response.json)
  }).pipe(Effect.timeout(timeout))
const status = (runner: Runner) => request(runner, Request.cases.Status.make({}), Status)
const mint = (runner: Runner) =>
  Effect.map(request(runner, Request.cases.Mint.make({}), Mint), (reply) => reply.commandId)
const state = (runner: Runner, key: string, actor: string = Ledger.name) =>
  request(runner, Request.cases.State.make({ actor, key }), State)
const call = (
  runner: Runner,
  commandId: string,
  key: string,
  member: string,
  payload: Schema.Json,
  actor: string = Ledger.name,
  drop = false,
) =>
  request(runner, Request.cases.Call.make({ actor, commandId, key, member, payload, drop }), Call)
const drain = (runner: Runner) => request(runner, Request.cases.Drain.make({}), Drain)
const clock = (runner: Runner, at: number) =>
  request(runner, Request.cases.Clock.make({ at }), ClockSet)

/** Polling asserts a condition; reaching the deadline is a failure, never a skipped scenario. */
const until = <A, E, R>(
  read: () => Effect.Effect<A, E, R>,
  accepts: (value: A) => boolean,
  label: string,
  timeout = 20_000,
) =>
  Effect.gen(function* () {
    const deadline = performance.now() + timeout
    let last: A | undefined
    while (performance.now() < deadline) {
      const value = yield* read()
      last = value
      if (accepts(value)) return value
      yield* pause(50)
    }
    yield* Console.log("Polling deadline", label, last)
    return yield* FixtureFailure.make({ reason: `Timed out: ${label}` })
  })

const cluster = Effect.gen(function* () {
  const adapter = yield* Config.String("BENCH_CLUSTER_ADAPTER").pipe(Config.withDefault("s3"))
  if (!["s3", "fileSystem"].includes(adapter))
    return yield* Effect.die(new RangeError("Cluster adapter must be s3 or fileSystem"))
  const directory =
    adapter === "fileSystem"
      ? yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.makeTempDirectoryScoped({ prefix: "akter-cluster-bench-" }),
        )
      : undefined
  const target = adapter === "s3" ? yield* Config.String("TEST_S3_URL") : ""
  const bucketAt = (prefix: string) =>
    directory === undefined
      ? Effect.gen(function* () {
          const url = new URL(target)
          return yield* s3Bucket({
            endpoint: `${url.protocol}//${url.host}`,
            bucket: url.pathname.replace(/^\/+|\/+$/gu, ""),
            credentials: {
              accessKeyId: decodeURIComponent(url.username),
              secretAccessKey: decodeURIComponent(url.password),
            },
            prefix,
          })
        })
      : fileSystemBucket(`${directory}/${prefix}`)
  if (directory === undefined) {
    const url = new URL(target)
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new S3Client({
            region: "us-east-1",
            endpoint: `${url.protocol}//${url.host}`,
            credentials: {
              accessKeyId: decodeURIComponent(url.username),
              secretAccessKey: decodeURIComponent(url.password),
            },
            forcePathStyle: true,
          }),
      ),
      (client) => Effect.sync(() => client.destroy()),
    )
    yield* Effect.tryPromise(() =>
      client.send(new CreateBucketCommand({ Bucket: url.pathname.replace(/^\/+|\/+$/gu, "") })),
    ).pipe(
      Effect.catchIf(
        (error) =>
          Predicate.hasProperty(error.cause, "name") &&
          (error.cause.name === "BucketAlreadyOwnedByYou" ||
            error.cause.name === "BucketAlreadyExists"),
        () => Effect.void,
      ),
    )
  }
  const number = run++
  const prefix = `cluster-process/${process.pid}-${yield* Clock.currentTimeMillis}-${number}/`
  const deployment = `process-evidence-${process.pid}-${number}`
  const authority = yield* RunnerAuthority.make()
  const start = Effect.fnUntraced(function* (
    writer: string,
    options: { readonly at?: number; readonly bundle?: string; readonly short?: boolean } = {},
  ) {
    const listen = yield* port
    const peer = yield* proxy(listen)
    const material = yield* authority.issue({ deployment, validFor: "1000 days" })
    const child = yield* Effect.acquireRelease(
      spawn({
        AKTER_CLUSTER_OPTIONS: yield* Schema.encodeEffect(Schema.fromJsonString(Options))({
          url: target,
          directory,
          prefix,
          writer,
          deployment,
          listen,
          advertised: peer.advertised,
          bundle: options.bundle ?? "process-evidence",
          short: options.short ?? true,
          at: options.at,
        }),
        AKTER_CLUSTER_CA: material.ca,
        AKTER_CLUSTER_CERTIFICATE: material.certificate,
        AKTER_CLUSTER_KEY: Redacted.value(material.key),
      }),
      stop,
    )
    let output = ""
    let errors = ""
    const drained = yield* Deferred.make<string>()
    let lines = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      lines += chunk.toString()
      const completed = lines.split("\n")
      lines = completed.pop() ?? ""
      for (const line of completed)
        if (line.startsWith("DRAINED ")) Deferred.doneUnsafe(drained, Exit.succeed(line.slice(8)))
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-2_000)
    })
    const control = yield* Effect.callback<number, FixtureFailure>((resume) => {
      const exited = () =>
        resume(
          Effect.fail(FixtureFailure.make({ reason: `Fixture exited during startup: ${errors}` })),
        )
      const data = (chunk: Buffer) => {
        output += chunk.toString()
        const match = /CONTROL (\d+)/u.exec(output)
        if (match !== null) resume(Effect.succeed(Number(match[1])))
      }
      child.once("exit", exited)
      child.stdout?.on("data", data)
      return Effect.sync(() => {
        child.off("exit", exited)
        child.stdout?.off("data", data)
      })
    }).pipe(Effect.timeout("20 seconds"))
    return {
      child,
      control,
      writer,
      proxy: peer,
      stop: () => stop(child),
      signalDrain: () =>
        Effect.andThen(
          Effect.sync(() => {
            child.kill("SIGTERM")
          }),
          Deferred.await(drained),
        ).pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(HostDrainReport))),
          Effect.timeout("20 seconds"),
        ),
    }
  })
  const logs = () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bucket = yield* bucketAt(prefix)
        const store = yield* storeOf(bucket, { shards: SHARDS })
        const shards = yield* Effect.forEach(
          Array.from({ length: SHARDS }, (_, shard) => shard),
          (shard) =>
            Effect.map(Stream.runCollect(store.read(shard, 0n)), (segments) =>
              Array.from(segments).map((segment) => ({
                shard,
                writer: segment.writer,
                offset: segment.offset,
                entries: segment.entries.map((bytes) =>
                  Result.getOrThrow(EntryCodec.decode(bytes)),
                ),
              })),
            ),
          { concurrency: 4 },
        )
        return shards.flat()
      }),
    )
  const tailActions = (shard: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const bucket = yield* bucketAt(prefix)
        const key = (yield* bucket.list(checkpointPrefix(shard)))[0]!
        const manifest = yield* decodeManifest(key)(Option.getOrThrow(yield* bucket.get(key)))
        const store = yield* storeOf(bucket, { shards: SHARDS })
        const segments = yield* Stream.runCollect(store.read(shard, manifest.offset))
        return Array.from(segments)
          .flatMap((segment) =>
            segment.entries.map((bytes) => Result.getOrThrow(EntryCodec.decode(bytes))),
          )
          .filter(Entry.guards.Action).length
      }),
    )
  return { start, logs, tailActions, adapter }
})

type Cluster = Effect.Success<typeof cluster>
const withCluster = <A, E, R>(scenario: (opened: Cluster) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const services =
        globalThis.Bun === undefined
          ? (yield* Effect.promise(() => import("@effect/platform-node"))).NodeServices.layer
          : (yield* Effect.promise(() => import("@effect/platform-bun"))).BunServices.layer
      const context = yield* Layer.build(Layer.merge(FetchHttpClient.layer, services))
      return yield* Effect.flatMap(cluster, scenario).pipe(Effect.provide(context))
    }),
  )
const opened = (info: typeof Status.Type) =>
  info.shards.filter((shard) => shard.status === "open").map((shard) => shard.id)
const keyOn = (info: typeof Status.Type, actor = Ledger.name) => {
  const owned = new Set(opened(info))
  for (let candidate = 0; candidate < 10_000; candidate++) {
    const key = `key-${candidate}`
    if (owned.has(Durable.shardOf(Durable.addressOf(actor, key), SHARDS))) return key
  }
  throw new Error("Runner owns no shard")
}
const split = (runners: ReadonlyArray<Runner>) =>
  until(
    () => Effect.forEach(runners, status),
    (info) =>
      info.every((runner) => runner.ready && opened(runner).length > 0) &&
      info.flatMap(opened).length === SHARDS,
    "all shards uniquely open on the live runners",
  )

describe("real MinIO multi-process Cluster", () => {
  it.live(
    "F17′/F27 jobs reject duplicate cross-owner calls before reply journaling, lost sleep deadlines and owner-local retirement",
    () =>
      withCluster((group) =>
        Effect.gen(function* () {
          const origin = yield* group.start("job-origin")
          const receiver = yield* group.start("job-receiver")
          const info = yield* split([origin, receiver])
          const from = keyOn(info[0]!)
          const to = keyOn(info[1]!)
          const fromShard = Durable.shardOf(Durable.addressOf(Ledger.name, from), SHARDS)
          yield* request(
            origin,
            Request.cases.HoldJobReply.make({}),
            Schema.Struct({ held: Schema.Boolean }),
          )
          yield* call(origin, yield* mint(origin), from, "submit", {
            to,
            amount: 37,
            delay: 60_000,
          })
          yield* until(
            () => state(receiver, to),
            (value) => value["total"] === 37,
            "remote job call durable before its reply journal",
          )
          yield* origin.stop()
          const sleeping = yield* until(
            () => status(receiver),
            (value) => opened(value).length === SHARDS && value.shards[fromShard]?.nextDue !== null,
            "job replay keeps receiver outcome and persists its workflow deadline",
          )
          const due = sleeping.shards[fromShard]!.nextDue!
          const report = yield* drain(receiver)
          expect(report.shards.find((shard) => shard.shard === fromShard)?.nextDue).toBe(due)
          yield* receiver.stop()
          const successor = yield* group.start("job-successor", { at: due + 1_000 })
          yield* until(
            () => state(successor, from),
            (value) => value["total"] === 11,
            "overdue workflow completes on the next owner",
          )
          yield* until(
            () => group.logs(),
            (logs) => logs.some((segment) => segment.entries.some(Entry.guards.JobRetired)),
            "receiver stream retirement is durable before job cleanup",
          )
          expect(yield* state(successor, to)).toEqual({ total: 37, deliveries: 0 })
          const entries = (yield* group.logs()).flatMap((segment) => segment.entries)
          const remote = entries.filter(
            (entry) =>
              Entry.guards.Action(entry) && Origin.guards.JobCall(entry.origin) && entry.key === to,
          )
          expect(remote).toHaveLength(1)
          const done = entries.filter(Entry.guards.Done)
          expect(done).toHaveLength(1)
          const retired = entries.filter(Entry.guards.Retired)
          expect(retired.filter((entry) => entry.jobId === done[0]!.jobId)).toHaveLength(2)
          expect(entries.filter(Entry.guards.JobRetired).map((entry) => entry.jobId)).toEqual([
            done[0]!.jobId,
          ])
          const peer = yield* group.start("job-peer", { at: due + 1_000 })
          const moved = yield* split([successor, peer])
          const nextFrom = keyOn(moved[0]!)
          const nextTo = keyOn(moved[1]!)
          const before = yield* state(peer, nextTo)
          yield* call(successor, yield* mint(successor), nextFrom, "submit", {
            to: nextTo,
            amount: 43,
            delay: 100,
          })
          const completed = yield* until(
            () => group.logs(),
            (logs) =>
              logs.flatMap((segment) => segment.entries).filter(Entry.guards.JobRetired).length ===
              2,
            "completion retires the stream on the other live peer before dropping its job",
          )
          expect((yield* state(peer, nextTo))["total"]).toBe(Number(before["total"]) + 43)
          const all = completed.flatMap((segment) => segment.entries)
          const nextJob = all
            .filter(Entry.guards.Done)
            .find((entry) => entry.jobId !== done[0]!.jobId)!
          expect(
            all.filter(Entry.guards.Retired).filter((entry) => entry.jobId === nextJob.jobId),
          ).toHaveLength(2)
        }),
      ),
    60_000,
  )
  it.live(
    "F16 rejects gateway-local execution and repeated application after a lost durable reply and peer partition",
    () =>
      withCluster((group) =>
        Effect.gen(function* () {
          const gateway = yield* group.start("gateway")
          const owner = yield* group.start("owner")
          const info = yield* split([gateway, owner])
          const key = keyOn(info[1]!)
          const id = yield* mint(gateway)
          expect(
            Result.isFailure(
              yield* Effect.result(call(gateway, id, key, "add", 17, Ledger.name, true)),
            ),
          ).toBe(true)
          expect(yield* call(gateway, id, key, "add", 17)).toEqual({
            reply: { kind: "Success", value: 17 },
            replayed: true,
          })
          owner.proxy.partition(true)
          const pending = yield* mint(gateway)
          const began = performance.now()
          expect(
            Result.isFailure(yield* Effect.result(call(gateway, pending, key, "add", 29))),
          ).toBe(true)
          expect(performance.now() - began).toBeLessThan(15_000)
          expect(opened(yield* status(owner))).toContain(
            Durable.shardOf(Durable.addressOf(Ledger.name, key), SHARDS),
          )
          owner.proxy.partition(false)
          yield* call(gateway, pending, key, "add", 29)
          expect(yield* state(gateway, key)).toEqual({ total: 46, deliveries: 0 })
          const actions = (yield* group.logs())
            .flatMap((segment) => segment.entries)
            .filter(Entry.guards.Action)
          expect(actions.filter((entry) => entry.commandId === id)).toHaveLength(1)
          expect(actions.filter((entry) => entry.commandId === pending)).toHaveLength(1)
          expect(
            (yield* group.logs())
              .filter((segment) =>
                segment.entries.some(
                  (entry) => Entry.guards.Action(entry) && entry.commandId === id,
                ),
              )
              .map((segment) => segment.writer),
          ).toEqual(["owner"])
        }),
      ),
    60_000,
  )

  it.live(
    "F13 rejects dropping or duplicating a durable cross-shard send after sender SIGKILL and receiver restart",
    () =>
      withCluster((group) =>
        Effect.gen(function* () {
          const sender = yield* group.start("sender")
          const receiver = yield* group.start("receiver")
          const info = yield* split([sender, receiver])
          const from = keyOn(info[0]!)
          const to = keyOn(info[1]!)
          receiver.proxy.partition(true)
          const id = yield* mint(sender)
          yield* call(sender, id, from, "send", { to, amount: 23 })
          yield* sender.stop()
          receiver.proxy.partition(false)
          const successor = yield* group.start("successor")
          yield* split([receiver, successor])
          yield* until(
            () => state(successor, to),
            (value) => value["total"] === 23,
            "pending send reaches the actual receiver owner",
          )
          expect(yield* state(successor, to)).toEqual({ total: 23, deliveries: 1 })
          const replay = yield* call(successor, id, from, "send", { to, amount: 23 })
          expect(replay.replayed).toBe(true)
          yield* drain(receiver)
          yield* receiver.stop()
          yield* until(
            () => status(successor),
            (value) => opened(value).length === SHARDS,
            "receiver watermark moves with its shard",
          )
          expect(yield* state(successor, to)).toEqual({ total: 23, deliveries: 1 })
          const entries = (yield* group.logs()).flatMap((segment) => segment.entries)
          const senderEntries = entries.filter(
            (entry) => Entry.guards.Action(entry) && entry.commandId === id,
          )
          expect(senderEntries).toHaveLength(1)
          expect(
            entries.filter((entry) => Entry.guards.Action(entry) && entry.member === "receive"),
          ).toHaveLength(1)
          expect(entries.filter(Entry.guards.Delivered)).toHaveLength(1)
        }),
      ),
    60_000,
  )

  it.live(
    "F14 and F27 reject a lost or duplicated timer through owner death and a host wake using drained nextDue",
    () =>
      withCluster((group) =>
        Effect.gen(function* () {
          const a = yield* group.start("timer-owner")
          const b = yield* group.start("timer-successor")
          const info = yield* split([a, b])
          const key = keyOn(info[0]!)
          const due = (yield* status(a)).now + 1_000
          const id = yield* mint(a)
          yield* call(a, id, key, "remind", { at: due, amount: 31 })
          yield* a.stop()
          yield* until(
            () => status(b),
            (value) => opened(value).length === SHARDS,
            "timer shard fails over",
          )
          yield* until(
            () => state(b, key),
            (value) => value["total"] === 31,
            "late timer fires once",
          )
          const secondDue = (yield* status(b)).now + 2_000
          yield* call(b, yield* mint(b), key, "remind", { at: secondDue, amount: 47 })
          const report = yield* b.signalDrain()
          expect(report.outcome).toBe("clean")
          expect(report.shards.find((shard) => shard.nextDue !== null)?.nextDue).toBe(secondDue)
          yield* b.stop()
          yield* pause(Math.max(0, secondDue - (yield* Clock.currentTimeMillis)) + 50)
          const c = yield* group.start("host-wake")
          yield* until(
            () => status(c),
            (value) => opened(value).length === SHARDS,
            "host restarts stopped store after nextDue",
          )
          yield* until(
            () => state(c, key),
            (value) => value["total"] === 78,
            "timer due without any process recovers",
          )
          const entries = (yield* group.logs()).flatMap((segment) => segment.entries)
          const scheduled = entries
            .filter(Entry.guards.Action)
            .flatMap((entry) => entry.effects.timers)
          expect(scheduled.map((timer) => timer.at)).toEqual([due, secondDue])
          const fired = entries
            .filter(Entry.guards.Action)
            .filter((entry) => Origin.guards.Fired(entry.origin))
          expect(fired.map((entry) => entry.commandId)).toEqual(
            scheduled.map((timer) => timer.commandId),
          )
          expect(
            entries.filter(
              (entry) => Entry.guards.Action(entry) && Origin.guards.Fired(entry.origin),
            ),
          ).toHaveLength(2)
          expect(yield* state(c, key)).toEqual({ total: 78, deliveries: 2 })
        }),
      ),
    60_000,
  )

  it.live(
    "F15 rejects skipping a persisted spring-gap tick or firing both autumn occurrences after process restart",
    () =>
      withCluster((group) =>
        Effect.gen(function* () {
          for (const transition of [
            {
              actor: Spring,
              before: "2027-03-14T06:59:00Z",
              due: "2027-03-14T07:00:00Z",
              after: "2027-03-14T07:30:00Z",
              next: "2027-03-15T06:30:00Z",
            },
            {
              actor: Autumn,
              before: "2026-11-01T05:29:00Z",
              due: "2026-11-01T05:30:00Z",
              after: "2026-11-01T06:30:00Z",
              next: "2026-11-02T06:30:00Z",
            },
          ]) {
            const prefixWriter = transition.actor.name
            const a = yield* group.start(`${prefixWriter}-old`, {
              at: Date.parse(transition.before),
            })
            yield* until(
              () => status(a),
              (value) => opened(value).length === SHARDS,
              "zoned actor owner opens",
            )
            const key = `${prefixWriter}-key`
            yield* call(a, yield* mint(a), key, "touch", null, transition.actor.name)
            const report = yield* drain(a)
            expect(
              report.shards.some((shard) => shard.nextDue === Date.parse(transition.due)),
            ).toBe(true)
            yield* a.stop()
            const b = yield* group.start(`${prefixWriter}-new`, { at: Date.parse(transition.due) })
            yield* until(
              () => status(b),
              (value) => opened(value).length === SHARDS,
              "new process recovers persisted zoned due instant",
            )
            yield* until(
              () => state(b, key, transition.actor.name),
              (value) => value["ticks"] === 1,
              "first zoned tick fires",
            )
            yield* clock(b, Date.parse(transition.after))
            yield* pause(150)
            expect(yield* state(b, key, transition.actor.name)).toEqual({ ticks: 1 })
            expect(
              (yield* status(b)).shards.some(
                (shard) => shard.nextDue === Date.parse(transition.next),
              ),
            ).toBe(true)
            yield* drain(b)
            yield* b.stop()
          }
          const ticks = (yield* group.logs())
            .flatMap((segment) => segment.entries)
            .filter(
              (entry) =>
                Entry.guards.Action(entry) &&
                Origin.guards.Fired(entry.origin) &&
                entry.member === "tick",
            )
          expect(ticks).toHaveLength(2)
        }),
      ),
    60_000,
  )

  it.live(
    "F24 rejects another build opening a live owner's unreleased shard and readiness staying true during drain",
    () =>
      withCluster((group) =>
        Effect.gen(function* () {
          const old = yield* group.start("release-old", { bundle: "v1", short: false })
          yield* until(
            () => status(old),
            (value) => opened(value).length === SHARDS && value.ready,
            "old release owns every shard",
          )
          const key = keyOn(yield* status(old))
          yield* call(old, yield* mint(old), key, "add", 53)
          old.child.kill("SIGSTOP")
          const next = yield* group.start("release-new", { bundle: "v2", short: false })
          yield* pause(1_000)
          expect(opened(yield* status(next))).toEqual([])
          old.child.kill("SIGCONT")
          yield* until(
            () => status(old),
            (info) => info.ready,
            "stopped owner resumes before signal drain",
          )
          const draining = yield* Effect.forkChild(old.signalDrain())
          const during = yield* until(
            () => status(old),
            (info) => !info.ready && (info.reason ?? "").startsWith("drain"),
            "drain makes the host unready",
          )
          expect(during.ready).toBe(false)
          expect(during.reason).toMatch(/drain/u)
          const report = yield* Fiber.join(draining)
          expect(report.outcome).toBe("clean")
          const checkpoints = (yield* status(old)).checkpointReady
          expect(checkpoints.length).toBeGreaterThan(0)
          expect(checkpoints).toEqual(checkpoints.map(() => false))
          yield* until(
            () => status(next),
            (value) => opened(value).length === SHARDS && value.ready,
            "released shards open on the next build",
            40_000,
          )
          expect(yield* state(next, key)).toEqual({ total: 53, deliveries: 0 })
          const logs = yield* group.logs()
          for (const shard of Array.from({ length: SHARDS }, (_, id) => id)) {
            const chain = logs.filter((segment) => segment.shard === shard)
            const first = chain.findIndex((segment) => segment.writer === "release-new")
            expect(first).toBeGreaterThan(0)
            expect(chain[first - 1]!.entries.some(Entry.guards.Released)).toBe(true)
          }
        }),
      ),
    70_000,
  )

  it.live(
    "T6 measures actual clean handoff, default-timing crash takeover and 10,000-action-entry tail replay without relabeling short timings",
    () =>
      withCluster((group) =>
        Effect.gen(function* () {
          const old = yield* group.start("bench-old", { short: false })
          yield* until(
            () => status(old),
            (value) => opened(value).length === SHARDS && value.ready,
            "benchmark owner opens",
          )
          const key = keyOn(yield* status(old))
          const bulk = yield* request(
            old,
            Request.cases.Bulk.make({ key, count: 10_000 }),
            Bulk,
            120_000,
          )
          const before = (yield* group.logs())
            .flatMap((segment) => segment.entries)
            .filter(Entry.guards.Action)
          expect(before).toHaveLength(10_000)
          expect(yield* state(old, key)).toEqual({ total: 50_000, deliveries: 0 })
          const standby = yield* group.start("bench-standby", { short: false })
          const cleanStart = performance.now()
          expect((yield* drain(old)).outcome).toBe("clean")
          yield* until(
            () => status(standby),
            (value) => opened(value).length === SHARDS && value.ready,
            "default-timing clean move",
            60_000,
          )
          expect((yield* call(standby, bulk.lastId, key, "add", bulk.lastAmount)).replayed).toBe(
            true,
          )
          const cleanMs = performance.now() - cleanStart
          const second = yield* request(
            standby,
            Request.cases.Bulk.make({ key, count: 10_000 }),
            Bulk,
            120_000,
          )
          expect(
            yield* group.tailActions(Durable.shardOf(Durable.addressOf(Ledger.name, key), SHARDS)),
          ).toBe(10_000)
          const crashStart = performance.now()
          yield* standby.stop()
          const replacement = yield* group.start("bench-replacement", { short: false })
          yield* until(
            () => status(replacement),
            (value) => opened(value).length === SHARDS && value.ready,
            "default-timing crash takeover",
            75_000,
          )
          expect(
            (yield* call(replacement, second.lastId, key, "add", second.lastAmount)).replayed,
          ).toBe(true)
          const crashMs = performance.now() - crashStart
          const replay = (yield* status(replacement)).shards.find(
            (shard) => shard.id === Durable.shardOf(Durable.addressOf(Ledger.name, key), SHARDS),
          )!.replayMs
          expect(replay).not.toBeNull()
          expect(yield* state(replacement, key)).toEqual({ total: 100_000, deliveries: 0 })
          yield* Console.log({
            benchmark: "T6",
            provider: group.adapter === "s3" ? "MinIO loopback Docker" : "filesystem macOS APFS",
            host: hostname(),
            platform: platform(),
            arch: arch(),
            runtime: globalThis.Bun === undefined ? "node" : "bun",
            version: globalThis.Bun === undefined ? process.version : Bun.version,
            timing: `defaults: expiration ${Duration.toMillis(runnerDefaults.shardLockExpiration)}ms, assignment refresh ${Duration.toMillis(runnerDefaults.refreshAssignmentsInterval)}ms, lock refresh ${Duration.toMillis(runnerDefaults.shardLockRefreshInterval)}ms, heartbeat floor 1500ms`,
            actions: 10_000,
            writeMs: bulk.elapsedMs,
            cleanMs,
            crashMs,
            replayMs: replay,
            cleanTarget: cleanMs <= 5_000,
            crashTarget: crashMs <= 5_000,
            replayTarget: replay !== null && replay <= 1_000,
          })
        }),
      ),
    240_000,
  )
})
