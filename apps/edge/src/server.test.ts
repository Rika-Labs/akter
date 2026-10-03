import {
  type ConformanceBackend,
  type ConformanceEdge,
  describeConformance,
} from "@rikalabs/akter/testing"
import { BunCrypto, BunHttpServer } from "@effect/platform-bun"
import {
  Context,
  Crypto,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
  Schedule,
  Scope,
} from "effect"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createDatabase, startEdge } from "./fixtures.ts"

const harness = ManagedRuntime.make(BunCrypto.layer)

afterAll(() => harness.dispose())

const edge: ConformanceEdge = {
  start: (options) =>
    Effect.gen(function* () {
      const crypto = Context.get(yield* Layer.build(BunCrypto.layer), Crypto.Crypto)

      return yield* startEdge(options).pipe(Effect.provideService(Crypto.Crypto, crypto))
    }),
}

const backend: ConformanceBackend = {
  independentConnections: true,
  freshDatabases: true,
  services: BunCrypto.layer,
  httpServer: Layer.orDie(BunHttpServer.layerServer({ hostname: "127.0.0.1", port: 0 })),
  edge,
  open: () =>
    harness.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const crypto = yield* Crypto.Crypto

        const provision = (prefix: string) =>
          createDatabase(prefix).pipe(
            Scope.provide(scope),
            Effect.orDie,
            Effect.map(Redacted.make),
            Effect.provideService(Crypto.Crypto, crypto),
          )

        return {
          database: yield* provision("runners"),
          freshDatabase: provision("isolated"),
          copy: (database) =>
            Effect.gen(function* () {
              if (!Redacted.isRedacted(database))
                return yield* Effect.die(
                  new Error("The edge backend copies only Postgres databases"),
                )
              const source = new URL(Redacted.value(database)).pathname.slice(1)
              const base = new URL(Redacted.value(database))
              const name = `restored_${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`

              const admin = yield* Effect.acquireRelease(
                Effect.sync(() => new Pool({ connectionString: base.href })),
                (pool) => Effect.promise(() => pool.end()),
              )

              yield* Effect.acquireRelease(
                Effect.tryPromise(() =>
                  admin.query(`CREATE DATABASE "${name}" TEMPLATE "${source}"`),
                ).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })),
                () =>
                  Effect.promise(() =>
                    admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
                  ),
              )
              base.pathname = `/${name}`

              return Redacted.make(base.href)
            }).pipe(Scope.provide(scope), Effect.orDie),
          close: Scope.close(scope, Exit.void),
        }
      }),
    ),
}

describeConformance({
  name: "Hosted edge",
  backend,
  groups: ["edge", "coldServeEdge"],
  registrar: { describe, it, beforeAll, afterAll, expect, skip: (name) => it.skip(name) },
})
