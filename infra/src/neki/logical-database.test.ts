import { PgClient } from "@effect/sql-pg"
import { Clock, Config, Data, Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, describe, expect, it } from "vitest"
import { NekiLogicalDatabaseProvider } from "./logical-database.ts"
import type { NekiLogicalDatabaseAttributes, NekiLogicalDatabaseProps } from "./logical-database.ts"
import { Neki } from "./resources.ts"

const runtime = ManagedRuntime.make(NekiLogicalDatabaseProvider)
afterAll(() => runtime.dispose())

type Env = Layer.Success<typeof NekiLogicalDatabaseProvider>

type ProviderService = Effect.Success<typeof Neki.LogicalDatabase.Provider>

type DiffResult = { readonly action: string } | void

type ProviderOperations = {
  readonly reconcile: (
    input: Parameters<ProviderService["reconcile"]>[0],
  ) => Effect.Effect<NekiLogicalDatabaseAttributes, Error>
  readonly read?: (
    input: Parameters<NonNullable<ProviderService["read"]>>[0],
  ) => Effect.Effect<NekiLogicalDatabaseAttributes | undefined, Error>
  readonly delete: (input: Parameters<ProviderService["delete"]>[0]) => Effect.Effect<void, Error>
  readonly diff?: (
    input: Parameters<NonNullable<ProviderService["diff"]>>[0],
  ) => Effect.Effect<DiffResult, Error>
}

class DatabaseFailure extends Data.TaggedError("DatabaseFailure")<{ readonly message: string }> {}

const session = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
}

const base = { id: "Preview", fqn: "Preview", instanceId: "instance" }

const lift = <A, R>(effect: Effect.Effect<A, Error, R>) =>
  Effect.mapError(effect, (error) => new DatabaseFailure({ message: String(error) }))

const provider = Effect.map(Neki.LogicalDatabase.Provider, (service): ProviderOperations => service)

let counter = 0

const unique = Effect.map(Clock.currentTimeMillis, (millis) => {
  counter += 1
  return `akter_611_${millis.toString(36)}_${counter}`
})

const on = <A, E>(
  url: Redacted.Redacted<string>,
  statements: Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(PgClient.layer({ url, maxConnections: 1 }))
    return yield* Effect.provideContext(statements, context)
  }).pipe(Effect.scoped, Effect.orDie)

const databases = (url: Redacted.Redacted<string>, name: string) =>
  on(
    url,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* sql`SELECT datname FROM pg_database WHERE datname = ${name}`
    }),
  )

const inDatabase = (url: Redacted.Redacted<string>, name: string) => {
  const target = new URL(Redacted.value(url))
  target.pathname = `/${name}`
  return Redacted.make(target.toString())
}

const test = (
  name: string,
  program: (url: Redacted.Redacted<string>) => Effect.Effect<void, DatabaseFailure, Env>,
) =>
  it(name, () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const url = yield* Config.Redacted("TEST_DATABASE_URL")
        yield* program(url)
      }).pipe(Effect.orDie),
    ),
  )

const reconcile = (news: NekiLogicalDatabaseProps, output?: NekiLogicalDatabaseAttributes) =>
  Effect.gen(function* () {
    const service = yield* provider
    return yield* lift(
      service.reconcile({ ...base, news, olds: undefined, output, session, bindings: [] }),
    )
  })

const read = (olds: NekiLogicalDatabaseProps, output?: NekiLogicalDatabaseAttributes) =>
  Effect.gen(function* () {
    const service = yield* provider
    return yield* lift(service.read?.({ ...base, olds, output }) ?? Effect.undefined)
  })

const remove = (olds: NekiLogicalDatabaseProps, output: NekiLogicalDatabaseAttributes) =>
  Effect.gen(function* () {
    const service = yield* provider
    return yield* lift(service.delete({ ...base, olds, output, session, bindings: [] }))
  })

const diff = (
  olds: NekiLogicalDatabaseProps,
  news: NekiLogicalDatabaseProps,
  output: NekiLogicalDatabaseAttributes,
) =>
  Effect.gen(function* () {
    const service = yield* provider
    return yield* lift(
      service.diff?.({ ...base, olds, news, oldBindings: [], newBindings: [], output }) ??
        Effect.void,
    )
  })

describe("NekiLogicalDatabase provider against Postgres", () => {
  test("creates a database that can be connected to and holds its own tables", (url) =>
    Effect.gen(function* () {
      const name = yield* unique
      const props = { name, connectionUrl: url }
      const output = yield* reconcile(props)
      expect(output).toEqual({ name })
      expect(yield* databases(url, name)).toHaveLength(1)
      const count = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name = 'preview_only'`
      })
      const created = yield* on(
        inDatabase(url, name),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`CREATE TABLE preview_only (id int)`
          return yield* count
        }),
      )
      expect(created[0]?.count).toBe(1)
      expect((yield* on(url, count))[0]?.count).toBe(0)
      yield* remove(props, output)
    }))

  test("converges when the database already exists and when reconciled again", (url) =>
    Effect.gen(function* () {
      const name = yield* unique
      const props = { name, connectionUrl: url }
      yield* on(
        url,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`CREATE DATABASE ${sql(name)}`
        }),
      )
      const first = yield* reconcile(props)
      const second = yield* reconcile(props, first)
      expect(second).toEqual({ name })
      expect(yield* databases(url, name)).toHaveLength(1)
      yield* remove(props, second)
    }))

  test("reads a database as present until it is dropped", (url) =>
    Effect.gen(function* () {
      const name = yield* unique
      const props = { name, connectionUrl: url }
      const output = yield* reconcile(props)
      expect(yield* read(props, output)).toEqual({ name })
      yield* remove(props, output)
      expect(yield* read(props, output)).toBeUndefined()
      expect(yield* read(props)).toBeUndefined()
    }))

  test("drops the database even while a connection to it is open, and again without error", (url) =>
    Effect.gen(function* () {
      const name = yield* unique
      const props = { name, connectionUrl: url }
      const output = yield* reconcile(props)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            PgClient.layer({ url: inDatabase(url, name), maxConnections: 1 }),
          )
          yield* Effect.provideContext(
            Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT 1`),
            context,
          )
          yield* remove(props, output)
          expect(yield* databases(url, name)).toHaveLength(0)
        }),
      ).pipe(Effect.orDie)
      yield* remove(props, output)
    }))

  test("refuses a name that is not a plain lowercase identifier before issuing any statement", (url) =>
    Effect.gen(function* () {
      for (const name of [
        "Preview",
        'x"; DROP DATABASE postgres; --',
        "1abc",
        "",
        "a".repeat(64),
      ]) {
        const outcome = yield* Effect.exit(reconcile({ name, connectionUrl: url }))
        expect(outcome._tag).toBe("Failure")
      }
      expect(yield* databases(url, "postgres")).toHaveLength(1)
    }))

  test("replaces the database when its name changes", (url) =>
    Effect.gen(function* () {
      const props = { name: yield* unique, connectionUrl: url }
      const output = yield* reconcile(props)
      expect(yield* diff(props, { ...props, name: yield* unique }, output)).toEqual({
        action: "replace",
      })
      expect(yield* diff(props, props, output)).toBeUndefined()
      yield* remove(props, output)
    }))
})
