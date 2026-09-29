import { BunCrypto, BunHttpServer, BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer, ManagedRuntime, Redacted, Scope } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Actor, Actors } from "../../../../index.ts"
import { ActorTest } from "../../../actor-test.ts"
import {
  type ConformanceBackend,
  type ConformanceCase,
  type ConformanceDatabase,
  describeConformance,
} from "../../../conformance.ts"
import { restoreConformance, Vault, vaultOf } from "../../restore.ts"
import { archivingPostgres } from "./online-restore.ts"

type Server = Effect.Success<ReturnType<typeof archivingPostgres>>

const runtime = ManagedRuntime.make(BunServices.layer)

let server: Server

let scope: Scope.Closeable

beforeAll(async () => {
  scope = await runtime.runPromise(Scope.make())
  server = await runtime.runPromise(
    archivingPostgres().pipe(Effect.provideService(Scope.Scope, scope)),
  )
}, 180_000)

afterAll(async () => {
  await runtime.runPromise(Scope.close(scope, Exit.void))
  await runtime.dispose()
})

const databaseOf = (database: ConformanceDatabase) =>
  Redacted.isRedacted(database)
    ? new URL(Redacted.value(database)).pathname.slice(1)
    : Effect.runSync(Effect.die(new Error("The drill backs up Postgres databases only")))

const total = (state: unknown) => Number((state as { total?: number }).total ?? 0)

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
    Effect.promise(() =>
      runtime.runPromise(
        server.dump(databaseOf(database)).pipe(Effect.flatMap(server.restoreDump)),
      ),
    ),
}

let points = 0

const recovered: Backup = {
  name: "Postgres point-in-time recovery",
  database: "recovered",
  copy: (database) =>
    Effect.promise(() =>
      runtime.runPromise(
        Effect.gen(function* () {
          points += 1
          const name = `snapshot_${points}`
          yield* server.mark(name)

          return yield* server.recoverTo(name, databaseOf(database))
        }),
      ),
    ),
}

const backendOf = (backup: Backup): ConformanceBackend => ({
  independentConnections: true,
  services: BunCrypto.layer,
  httpServer: Layer.orDie(BunHttpServer.layerServer({ hostname: "127.0.0.1", port: 0 })),
  open: async () => {
    let fresh = 0
    await runtime.runPromise(server.createDatabase(backup.database))

    return {
      database: server.url(backup.database),
      freshDatabase: Effect.promise(async () => {
        fresh += 1
        await runtime.runPromise(server.createDatabase(`${backup.database}_fresh_${fresh}`))

        return server.url(`${backup.database}_fresh_${fresh}`)
      }),
      copy: backup.copy,
      close: Effect.void,
    }
  },
})

/**
 * Takes the backup while six vaults keep committing deposits, then restores
 * it and checks that it is one snapshot: each vault's state equals its
 * receipts, every command acknowledged before the backup began replays
 * without running its handler again, the tail written during and after the
 * backup is absent, and each pending transfer is delivered once.
 */
const consistentWhileCommitting = (backup: Backup): ConformanceCase => ({
  name: "restores one consistent snapshot of a database whose turns keep committing during the backup",
  timeoutMs: 240_000,
  run: async ({ expect, environment, fixture }) => {
    const ids = Array.from({ length: 6 }, (_, index) => `online-${backup.database}-${index}`)
    const acknowledged: Array<{
      readonly vault: string
      readonly id: string
      readonly total: number
    }> = []
    let stopped = false

    const tenant = await environment.run(
      Effect.gen(function* () {
        yield* Effect.forEach(ids, (id) =>
          Vault.get(id).pipe(
            Effect.flatMap((vault) => vault.Transfer({ to: `${id}-to`, amount: 3 })),
          ),
        )

        return (yield* ActorTest).tenant
      }),
    )

    const writing = environment.run(
      Effect.forEach(
        ids,
        (id) =>
          Effect.gen(function* () {
            const vault = yield* Vault.get(id)
            const actors = yield* Actors

            while (!stopped) {
              const commandId = yield* actors.mintCommandId
              const reached = yield* vault.Deposit(1).pipe(Actor.commandId(commandId))
              acknowledged.push({ vault: id, id: commandId, total: reached })
            }
          }),
        { concurrency: "unbounded", discard: true },
      ),
    )

    while (acknowledged.length < 60) await new Promise((resolve) => setTimeout(resolve, 20))

    const before = [...acknowledged]
    const snapshot = await Effect.runPromise(backup.copy(server.url(backup.database)))
    const during = acknowledged.length
    await new Promise((resolve) => setTimeout(resolve, 500))
    stopped = true
    await writing
    const written = acknowledged.length

    expect(written > during).toBe(true)

    const restored = environment.build({ database: snapshot })

    try {
      await restored.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const test = yield* ActorTest
            let deposits = 0

            for (const id of ids) {
              const inspected = yield* test.inspect((yield* vaultOf(tenant, id)).ref)
              expect(total(inspected.state)).toBe(inspected.receipts - 1)
              deposits += total(inspected.state)
            }

            expect(deposits >= before.length).toBe(true)
            expect(deposits < written).toBe(true)

            const ran = fixture.restore.deposits

            for (const { vault, id, total: reached } of before.slice(0, 40))
              expect(
                yield* (yield* vaultOf(tenant, vault)).Deposit(1).pipe(Actor.commandId(id)),
              ).toBe(reached)

            expect(fixture.restore.deposits).toBe(ran)

            yield* test.advance("2 minutes")

            for (const id of ids)
              expect(yield* test.inspect((yield* vaultOf(tenant, `${id}-to`)).ref)).toMatchObject({
                state: { total: 3 },
                receipts: 1,
              })
          }),
        ),
      )
    } finally {
      await restored.dispose()
    }
  },
})

/**
 * Recovers to two named restore points taken between phases of deposits and
 * checks that each recovered database holds exactly the phases before its
 * point, with the transfer staged before the first point still pending.
 */
const recoversToEachRestorePoint: ConformanceCase = {
  name: "recovers to a named restore point holding exactly the commits before it",
  timeoutMs: 240_000,
  run: async ({ expect, environment }) => {
    const ids = Array.from({ length: 3 }, (_, index) => `pitr-${index}`)

    const deposit = (amount: number) =>
      Effect.forEach(ids, (id) =>
        Vault.get(id).pipe(Effect.flatMap((vault) => vault.Deposit(amount))),
      )

    const tenant = await environment.run(
      Effect.gen(function* () {
        yield* Effect.forEach(ids, (id) =>
          Vault.get(id).pipe(
            Effect.flatMap((vault) =>
              vault.Deposit(5).pipe(Effect.andThen(vault.Transfer({ to: `${id}-to`, amount: 2 }))),
            ),
          ),
        )

        return (yield* ActorTest).tenant
      }),
    )

    await runtime.runPromise(server.mark("pitr_first"))
    await environment.run(deposit(7))
    await runtime.runPromise(server.mark("pitr_second"))
    await environment.run(deposit(11))

    const at = async (point: string, expected: number, receipts: number, pending: boolean) => {
      const database = await runtime.runPromise(server.recoverTo(point, "recovered"))
      const restored = environment.build({ database })

      try {
        await restored.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const test = yield* ActorTest

              for (const id of ids) {
                const vault = yield* vaultOf(tenant, id)
                expect(yield* test.inspect(vault.ref)).toMatchObject({
                  state: { total: expected },
                  receipts,
                })
              }

              if (pending) {
                const vault = yield* vaultOf(tenant, ids[0]!)
                expect(yield* test.inspect(vault.ref)).toMatchObject({ outbox: 1 })

                const targets = yield* Effect.forEach(ids, (id) => vaultOf(tenant, `${id}-to`))

                for (const target of targets)
                  expect(yield* test.inspect(target.ref)).toMatchObject({ receipts: 0 })

                yield* test.advance("2 minutes")

                for (const target of targets)
                  expect(yield* test.inspect(target.ref)).toMatchObject({
                    state: { total: 2 },
                    receipts: 1,
                  })

                expect(yield* test.inspect(vault.ref)).toMatchObject({ outbox: 0 })
              }

              expect(yield* (yield* vaultOf(tenant, ids[0]!)).Deposit(1)).toBe(expected + 1)
            }),
          ),
        )
      } finally {
        await restored.dispose()
      }
    }

    await at("pitr_first", 5, 2, true)
    await at("pitr_second", 12, 3, false)
  },
}

const restoreCases = restoreConformance.filter(({ name }) => !name.includes("rolling deploy"))

for (const [backup, extra] of [
  [dumped, []],
  [recovered, [recoversToEachRestorePoint]],
] as const)
  describeConformance({
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
    cases: [...restoreCases, consistentWhileCommitting(backup), ...extra],
  })
