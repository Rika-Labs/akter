import { BunCrypto, BunHttpServer, BunServices } from "@effect/platform-bun"
import { Effect, Exit, Fiber, Layer, ManagedRuntime, Redacted, Scope } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Actors } from "../../../../index.ts"
import { ActorTest } from "../../../actor-test.ts"
import {
  type ConformanceBackend,
  type ConformanceCase,
  type ConformanceDatabase,
  conformanceGroups,
  registerConformance,
} from "../../../conformance.ts"
import { type RestoreFixture, restoreSuite, vaults } from "../../restore.ts"
import { archivingPostgres } from "./online-restore.ts"

type Server = Effect.Success<ReturnType<typeof archivingPostgres>>

interface Total {
  readonly total?: number
}

let server: Server | undefined

let scope: Scope.Closeable | undefined

const runtime = ManagedRuntime.make(BunServices.layer)

/** Runs a container operation on the drill's server; a failure is a defect. */
const onServer = <A, E>(
  operation: (running: Server) => Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
) =>
  Effect.promise(() =>
    runtime.runPromise(
      Effect.suspend(() =>
        server === undefined
          ? Effect.die(new Error("The archiving server is not running"))
          : operation(server),
      ),
    ),
  )

beforeAll(
  () =>
    runtime.runPromise(
      Effect.gen(function* () {
        scope = yield* Scope.make()
        server = yield* archivingPostgres().pipe(Scope.provide(scope))
      }),
    ),
  180_000,
)

afterAll(() =>
  runtime
    .runPromise(scope === undefined ? Effect.void : Scope.close(scope, Exit.void))
    .then(() => runtime.dispose()),
)

const databaseOf = (database: ConformanceDatabase) =>
  Redacted.isRedacted(database)
    ? new URL(Redacted.value(database)).pathname.slice(1)
    : "the drill backs up Postgres databases only"

const totalOf = (state: Total) => state.total ?? 0

/**
 * How the drill takes the backup the restore cases restore from: an online
 * `pg_dump` restored with `pg_restore`, or a named restore point recovered
 * from the base backup and the WAL archive.
 */
interface Backup {
  readonly name: string
  readonly database: string
  readonly copy: (database: ConformanceDatabase) => Effect.Effect<ConformanceDatabase>
}

const dumped: Backup = {
  name: "Postgres pg_dump restored with pg_restore",
  database: "dumped",
  copy: (database) =>
    onServer((running) =>
      running.dump(databaseOf(database)).pipe(Effect.flatMap(running.restoreDump)),
    ),
}

let points = 0

const recovered: Backup = {
  name: "Postgres point-in-time recovery",
  database: "recovered",
  copy: (database) =>
    onServer((running) =>
      Effect.gen(function* () {
        points += 1
        const name = `snapshot_${points}`
        yield* running.mark(name)

        return yield* running.recoverTo(name, databaseOf(database))
      }),
    ),
}

const backendOf = (backup: Backup): ConformanceBackend => ({
  independentConnections: true,
  freshDatabases: true,
  services: BunCrypto.layer,
  httpServer: Layer.orDie(BunHttpServer.layerServer({ hostname: "127.0.0.1", port: 0 })),
  open: () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let fresh = 0
        const running = server!
        yield* running.createDatabase(backup.database)

        return {
          database: running.url(backup.database),
          freshDatabase: Effect.suspend(() => {
            fresh += 1
            const name = `${backup.database}_fresh_${fresh}`

            return running.createDatabase(name).pipe(Effect.as(running.url(name)))
          }),
          copy: backup.copy,
          close: Effect.void,
        }
      }),
    ),
})

/**
 * Takes the backup while six vaults keep committing deposits, then restores
 * it and checks that it is one snapshot: each vault's state equals its
 * receipts, every command acknowledged before the backup began replays
 * without running its handler again, the tail written during and after the
 * backup is absent, and each pending transfer is delivered once.
 */
const consistentWhileCommitting = (backup: Backup): ConformanceCase<RestoreFixture> => ({
  name: "restores one consistent snapshot of a database whose turns keep committing during the backup",
  timeoutMs: 240_000,
  run: ({ expect, environment, fixture }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const ids = Array.from({ length: 6 }, (_, index) => `online-${backup.database}-${index}`)

        const acknowledged: Array<{
          readonly vault: string
          readonly id: string
          readonly total: number
        }> = []

        let stopped = false

        const tenant = yield* Effect.promise(() =>
          environment.run(
            Effect.gen(function* () {
              yield* Effect.forEach(ids, (id) => vaults.transfer(id, `${id}-to`, 3))

              return (yield* ActorTest).tenant
            }),
          ),
        )

        const writing = yield* Effect.promise(() =>
          environment.run(
            Effect.forEach(
              ids,
              (id) =>
                Effect.gen(function* () {
                  const actors = yield* Actors

                  while (!stopped) {
                    const commandId = yield* actors.mintCommandId
                    const reached = yield* vaults.deposit(id, 1, { commandId })
                    acknowledged.push({ vault: id, id: commandId, total: reached })
                  }
                }),
              { concurrency: "unbounded", discard: true },
            ),
          ),
        ).pipe(Effect.forkChild)

        while (acknowledged.length < 60) yield* Effect.sleep("20 millis")

        const before = [...acknowledged]
        const snapshot = yield* backup.copy(server!.url(backup.database))
        const during = acknowledged.length
        yield* Effect.sleep("500 millis")
        stopped = true
        yield* Fiber.join(writing)
        const written = acknowledged.length

        expect(written > during).toBe(true)

        const restored = environment.build({ database: snapshot })

        yield* Effect.promise(() =>
          restored.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const test = yield* ActorTest
                let deposits = 0

                for (const id of ids) {
                  const inspected = yield* test.inspect(yield* vaults.ref(tenant, id))
                  expect(totalOf(inspected.state as Total)).toBe(inspected.receipts - 1)
                  deposits += totalOf(inspected.state as Total)
                }

                expect(deposits >= before.length).toBe(true)
                expect(deposits < written).toBe(true)

                const ran = fixture.deposits

                for (const { vault, id, total: reached } of before.slice(0, 40))
                  expect(yield* vaults.deposit(vault, 1, { tenant, commandId: id })).toBe(reached)

                expect(fixture.deposits).toBe(ran)

                yield* test.advance("2 minutes")

                for (const id of ids)
                  expect(yield* test.inspect(yield* vaults.ref(tenant, `${id}-to`))).toMatchObject({
                    state: { total: 3 },
                    receipts: 1,
                  })
              }),
            ),
          ),
        ).pipe(Effect.ensuring(Effect.promise(() => restored.dispose())))
      }),
    ),
})

/**
 * Recovers to two named restore points taken between phases of deposits and
 * checks that each recovered database holds exactly the phases before its
 * point, with the transfer staged before the first point still pending.
 */
const recoversToEachRestorePoint: ConformanceCase<RestoreFixture> = {
  name: "recovers to a named restore point holding exactly the commits before it",
  timeoutMs: 240_000,
  run: ({ expect, environment }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const ids = Array.from({ length: 3 }, (_, index) => `pitr-${index}`)

        const deposit = (amount: number) =>
          Effect.promise(() =>
            environment.run(Effect.forEach(ids, (id) => vaults.deposit(id, amount))),
          )

        const tenant = yield* Effect.promise(() =>
          environment.run(
            Effect.gen(function* () {
              yield* Effect.forEach(ids, (id) =>
                vaults.deposit(id, 5).pipe(Effect.andThen(vaults.transfer(id, `${id}-to`, 2))),
              )

              return (yield* ActorTest).tenant
            }),
          ),
        )

        yield* onServer((running) => running.mark("pitr_first"))
        yield* deposit(7)
        yield* onServer((running) => running.mark("pitr_second"))
        yield* deposit(11)

        const at = Effect.fnUntraced(function* (
          point: string,
          expected: number,
          receipts: number,
          pending: boolean,
        ) {
          const database = yield* onServer((running) => running.recoverTo(point, "recovered"))
          const restored = environment.build({ database })

          yield* Effect.promise(() =>
            restored.runPromise(
              Effect.scoped(
                Effect.gen(function* () {
                  const test = yield* ActorTest

                  for (const id of ids)
                    expect(yield* test.inspect(yield* vaults.ref(tenant, id))).toMatchObject({
                      state: { total: expected },
                      receipts,
                    })

                  if (pending) {
                    const vault = yield* vaults.ref(tenant, ids[0]!)
                    expect(yield* test.inspect(vault)).toMatchObject({ outbox: 1 })

                    const targets = yield* Effect.forEach(ids, (id) =>
                      vaults.ref(tenant, `${id}-to`),
                    )

                    for (const target of targets)
                      expect(yield* test.inspect(target)).toMatchObject({ receipts: 0 })

                    yield* test.advance("2 minutes")

                    for (const target of targets)
                      expect(yield* test.inspect(target)).toMatchObject({
                        state: { total: 2 },
                        receipts: 1,
                      })

                    expect(yield* test.inspect(vault)).toMatchObject({ outbox: 0 })
                  }

                  expect(yield* vaults.deposit(ids[0]!, 1, { tenant })).toBe(expected + 1)
                }),
              ),
            ),
          ).pipe(Effect.ensuring(Effect.promise(() => restored.dispose())))
        })

        yield* at("pitr_first", 5, 2, true)
        yield* at("pitr_second", 12, 3, false)
      }),
    ),
}

const restoreCases = conformanceGroups.restore.cases.filter(
  ({ name }) => !name.includes("rolling deploy"),
)

for (const [backup, extra] of [
  [dumped, []],
  [recovered, [recoversToEachRestorePoint]],
] as const)
  registerConformance({
    name: backup.name,
    backend: backendOf(backup),
    registrar: {
      describe,
      it,
      beforeAll,
      afterAll,
      expect,
      skip: (name) => it.skip(name),
    },
    selected: [
      {
        suite: restoreSuite,
        cases: [...restoreCases, consistentWhileCommitting(backup), ...extra],
      },
    ],
  })
