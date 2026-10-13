import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Option, Result, Schema, Scope, Stream } from "effect"
import { AuditRecord } from "../../../../packages/akter/src/store/audit.ts"
import { user } from "../../../../packages/akter/src/index.ts"
import { Durable } from "../../../../packages/akter/src/execution/durable.ts"
import { Entry, EntryCodec } from "../../../../packages/akter/src/execution/entries.ts"
import { Transports } from "../../../../packages/akter/src/execution/transport.ts"
import { Operators } from "../../../../packages/akter/src/runtime/operators/service.ts"
import type { OperatorGrant } from "../../../../packages/akter/src/runtime/operators/grants.ts"
import { Fault, Faults } from "../../../../packages/akter/src/store/faults.ts"
import type { EngineBackend, EngineLocation } from "./engine.ts"
import { Tally, add, assignAll, mint, runner } from "./engine-runner.ts"

const grant: OperatorGrant = {
  operator: "conformance-operator",
  capabilities: [
    "inspect",
    "log.read",
    "snapshot.read",
    "outcomes.read",
    "audit.read",
    "replay",
  ].map((action) => ({
    action: action as
      | "inspect"
      | "log.read"
      | "snapshot.read"
      | "outcomes.read"
      | "audit.read"
      | "replay",
    tenant: "default",
  })),
}
const started = <E>(
  location: EngineLocation<E>,
  writer: string,
  bundle = "conformance",
  faults = Faults.plan(),
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    )
    const running = yield* Scope.provide(scope)(
      Effect.flatMap(location.bucket, (bucket) =>
        runner(bucket, { writer, bundle, faults, checkpointEvery: 0 }),
      ),
    )
    return { ...running, crash: Scope.close(scope, Exit.void) }
  })

/** Index and operator failure evidence runs unchanged on memory, filesystem and real S3 protocols. */
export const operatorConformance = <E, CE>(backend: EngineBackend<E, CE>) =>
  describe(`Indexes and operators on ${backend.name}`, () => {
    it.live(
      "preserves ids-only index results through crash/tail recovery and checkpoint/owner handoff (rejects stale or missing index rows)",
      () =>
        Effect.gen(function* () {
          const location = yield* backend.location
          const a = yield* started(location, "index-a")
          yield* assignAll(a.engine)
          for (const [key, amount] of [
            ["c", 17],
            ["z", 5],
            ["b", 17],
            ["a", 29],
          ] as const)
            yield* add(a.engine, yield* mint, key, amount)
          const find = (engine: typeof a.engine) =>
            Transports.reads(engine, user("find-reader")).find({
              actor: Tally,
              query: { where: { total: { gte: 7, lt: 20 } }, orderBy: { field: "total" as never } },
            })
          expect(yield* find(a.engine)).toEqual(["b", "c"])
          yield* a.crash
          const b = yield* started(location, "index-b")
          yield* assignAll(b.engine)
          expect(yield* find(b.engine)).toEqual(["b", "c"])
          yield* add(b.engine, yield* mint, "c", 11)
          expect(yield* find(b.engine)).toEqual(["b"])
          yield* b.engine.drain("20 seconds")
          const c = yield* started(location, "index-c")
          yield* assignAll(c.engine)
          expect(yield* find(c.engine)).toEqual(["b"])
          for (const shard of c.engine.shards()) {
            const checkpoint = Option.getOrUndefined(
              c.engine.lease(shard.id)?.checkpoint ?? Option.none(),
            )
            expect(checkpoint?.indexPages.length).toBe(1)
          }
        }),
      60_000,
    )

    it.live(
      "audits every allowed and scope-denied read before answering, never fences or activates, and shows outcome tags without values (rejects unaudited reads and inspection privilege escalation)",
      () =>
        Effect.gen(function* () {
          const location = yield* backend.location
          const faults = Faults.plan()
          const a = yield* started(location, "operator-a", "conformance", faults)
          yield* assignAll(a.engine)
          const commandId = yield* mint
          yield* add(a.engine, commandId, "only", 37)
          const shard = a.engine.shardOf(Durable.addressOf(Tally.name, "only"))
          const engineHead = a.engine.lease(shard)?.head
          const operators = Operators.make(a.engine)
          const request = {
            operation: "inspect" as const,
            target: { actorType: Tally.name, actorId: "only" },
            tenant: "default",
            reason: "test inspection",
          }
          const held = yield* faults.inject(Fault.Hold(), {
            match: ({ kind, key }) => kind === "create" && key.startsWith("audit/"),
          })
          const reading = yield* Effect.forkChild(operators.run(grant, request))
          yield* held.fired
          expect(reading.pollUnsafe()).toBeUndefined()
          yield* held.release
          const inspect = yield* Fiber.join(reading)
          expect(inspect).toMatchObject({
            state: { total: 37 },
            outcomes: [{ commandId, outcome: "Success" }],
          })
          expect(
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(inspect),
          ).not.toContain('"value":37')
          expect((yield* a.store.audits).map((audit) => audit.outcome)).toEqual(["allowed"])
          expect(a.engine.lease(shard)?.head).toBe(engineHead)
          const scope = {
            operator: "scoped",
            capabilities: [
              {
                action: "inspect" as const,
                tenant: "default",
                actorType: Tally.name,
                actorId: "different",
              },
            ],
          }
          expect((yield* Effect.flip(operators.run(scope, request))).reason).toBe("scope")
          expect(
            (yield* Effect.flip(operators.run(grant, { ...request, tenant: "other" }))).reason,
          ).toBe("scope")
          const denied = (yield* a.store.audits).filter((audit) => audit.outcome === "denied")
          expect(denied.length).toBe(2)
          const missing = yield* Effect.flip(
            operators.run(grant, {
              ...request,
              target: { actorType: Tally.name, actorId: "missing" },
            }),
          )
          expect(missing.reason).toBe("not_found")
          const shardRead = yield* operators.run(grant, { ...request, target: { shard } })
          expect(shardRead).toMatchObject({ head: Number(engineHead), owner: "operator-a" })
          const log = yield* operators.run(grant, {
            ...request,
            operation: "log",
            target: { shard },
          })
          expect(log).toMatchObject({ entries: [{ entry: { actor: Tally.name, payload: 37 } }] })
          yield* a.engine.drain("20 seconds")
          const snapshot = yield* operators.run(grant, {
            ...request,
            operation: "snapshot",
            target: { shard },
          })
          expect(snapshot).toMatchObject({ checkpoint: { actors: [{ state: { total: 37 } }] } })
          const failed = yield* faults.inject(Fault.Unavailable({ status: 503 }), {
            match: ({ kind, key }) => kind === "create" && key.startsWith("audit/"),
            times: 100,
          })
          expect((yield* Effect.flip(operators.run(grant, request))).reason).toBe("unavailable")
          yield* failed.release
          const records = yield* a.store.audits
          expect(records.length).toBe(7)
          const auditText = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Array(AuditRecord)),
          )(records)
          expect(auditText).not.toContain("payload")
          expect(auditText).not.toContain('"total":37')
        }),
      60_000,
    )

    it.live(
      "build-matches replay, commits replay and audit together, and recovers if the checkpoint upload fails (rejects cross-build replay without opt-in and an unaudited replay result)",
      () =>
        Effect.gen(function* () {
          const location = yield* backend.location
          const a = yield* started(location, "old", "old-build")
          yield* assignAll(a.engine)
          yield* add(a.engine, yield* mint, "replay", 41)
          yield* a.crash
          const faults = Faults.plan()
          const b = yield* started(location, "new", "new-build", faults)
          yield* assignAll(b.engine)
          const shard = b.engine.shardOf(Durable.addressOf(Tally.name, "replay"))
          expect(b.engine.status(shard).status).toBe("refused")
          const operators = Operators.make(b.engine)
          const request = {
            operation: "replay" as const,
            target: { shard },
            tenant: "default",
            reason: "verified current handler",
            replay: "matching" as const,
          }
          expect((yield* Effect.flip(operators.run(grant, request))).reason).toBe("recovery")
          let creates = 0
          const held = yield* faults.inject(Fault.Hold(), {
            match: ({ kind, key }) =>
              kind === "create" &&
              key.startsWith(`s/${String(shard).padStart(2, "0")}/log/`) &&
              ++creates === 2,
          })
          const interrupted = yield* Effect.forkChild(
            operators.run(grant, { ...request, replay: "current" }),
          )
          yield* held.fired
          yield* Fiber.interrupt(interrupted)
          yield* held.release
          const before = yield* Stream.runCollect(b.store.read(shard, 0n))
          expect(
            before
              .flatMap((segment) => segment.entries)
              .map((bytes) => Result.getOrThrow(EntryCodec.decode(bytes))._tag),
          ).not.toContain("Replayed")
          const failed = yield* faults.inject(Fault.Unavailable({ status: 503 }), {
            match: ({ kind, key }) => kind === "put" && key.startsWith("pages/"),
            times: 100,
          })
          const response = yield* operators.run(grant, { ...request, replay: "current" })
          expect(response).toMatchObject({ replay: "current", shard })
          yield* failed.release
          yield* b.crash
          const c = yield* started(location, "restarted", "new-build")
          yield* assignAll(c.engine)
          expect((yield* c.engine.durableRecord(Tally, "replay")).image.encoded).toEqual({
            total: 41,
          })
          const segments = yield* Stream.runCollect(c.store.read(shard, 0n))
          const mutation = segments.find((segment) =>
            segment.entries.some((bytes) => {
              const entry = Result.getOrThrow(EntryCodec.decode(bytes))
              return Entry.guards.Replayed(entry)
            }),
          )
          expect(
            mutation?.entries.map((bytes) => Result.getOrThrow(EntryCodec.decode(bytes))._tag),
          ).toEqual(["Replayed", "Audit"])
          expect((yield* c.store.audits).map((audit) => audit.outcome)).toEqual(["refused"])
        }),
      60_000,
    )
  })
