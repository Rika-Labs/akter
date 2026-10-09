import { BunCrypto } from "@effect/platform-bun"
import {
  Cause,
  Config,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
  Schema,
  Stream,
} from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { Actor } from "../../../../../packages/akter/src/index.ts"
import { ColdStorage } from "../../../../../packages/akter/src/runtime/storage/cold-storage.ts"
import { disposableDatabase } from "../../../../../packages/akter/src/testing/database.ts"
import { ColdLedger, openCold } from "./cold-tier.ts"

const harness = ManagedRuntime.make(BunCrypto.layer)
afterAll(() => harness.dispose())
const database = disposableDatabase({
  url: Config.Redacted("TEST_DATABASE_URL").pipe(Effect.runSync),
})

const Set = Actor.command("Set", { payload: Schema.String })
const Show = Actor.query("Show", { success: Schema.String })
const old = { name: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))) }
const middle = { first: Schema.String, last: Schema.String }
const fields = { ...middle, tags: Schema.Array(Schema.String) }
const migrations = [
  Actor.migration(old, middle, ({ name }) => {
    const [first, ...last] = name.split(" ")
    return { first: first!, last: last.join(" ") }
  }),
  Actor.migration(middle, fields, (state) => ({ ...state, tags: [] })),
]
const Legacy = Actor.make("ColdProfile", {
  key: Schema.String,
  state: Actor.state(old),
  api: { Set, Show },
  policy: { coldAfter: 1 },
})
const Current = Actor.make("ColdProfile", {
  key: Schema.String,
  state: Actor.state(fields, { migrations }),
  api: { Set, Show },
  policy: { coldAfter: 1 },
})
const Shortened = Actor.make("ColdProfile", {
  key: Schema.String,
  state: Actor.state(fields, { migrations: migrations.slice(1) }),
  api: { Set, Show },
})
const legacyLayer = Layer.mergeAll(
  Legacy.toLayer({
    Set: Effect.fnUntraced(function* (name) {
      yield* (yield* Legacy.Turn).state.set({ name })
    }),
  }),
  Legacy.toQueryLayer({ Show: () => Effect.map(Legacy.Read, (read) => read.state.name) }),
)
const currentLayer = Layer.mergeAll(
  Current.toLayer({
    Set: Effect.fnUntraced(function* (tag) {
      const turn = yield* Current.Turn
      yield* turn.state.set({ tags: [...turn.state.tags, tag] })
    }),
  }),
  Current.toQueryLayer({
    Show: () =>
      Effect.map(
        Current.Read,
        (read) => `${read.state.first}|${read.state.last}|${read.state.tags.join(",")}`,
      ),
  }),
)

describe("cold state history and stopped-database restore with Postgres", () => {
  it("refuses a shortened cold state chain and upcasts the old object without writing until a successful turn", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const url = yield* database
        const store = ColdStorage.memory()
        const tenant = yield* Effect.scoped(
          Effect.gen(function* () {
            const { context, test, sql } = yield* openCold(
              url,
              store,
              undefined,
              undefined,
              legacyLayer,
            )
            const actor = yield* Legacy.get("ada").pipe(Effect.provideContext(context))
            yield* actor.Set("Ada King Lovelace")
            yield* test.hibernate(actor.ref)
            yield* test.advance(2)
            expect(yield* sql`SELECT cold_state_version FROM actor_generations`).toEqual([
              { cold_state_version: 0 },
            ])
            return actor.ref.tenant
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { context, sql } = yield* openCold(url, store, undefined, undefined, currentLayer)
            const actor = yield* Current.get("ada").pipe(
              Actor.tenant(tenant),
              Effect.provideContext(context),
            )
            expect(yield* actor.Show()).toBe("Ada|King Lovelace|")
            expect(yield* sql`SELECT count(*)::int AS n FROM actor_state`).toEqual([{ n: 0 }])
            expect(yield* sql`SELECT cold_state_version FROM actor_generations`).toEqual([
              { cold_state_version: 0 },
            ])
          }),
        )
        const refused = yield* openCold(
          url,
          store,
          undefined,
          undefined,
          Shortened.toQueryLayer({ Show: () => Effect.succeed("unreachable") }),
        ).pipe(Effect.scoped, Effect.exit)
        expect(Exit.isFailure(refused) && Cause.pretty(refused.cause)).toContain(
          "state chain is shortened",
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { context, sql } = yield* openCold(url, store, undefined, undefined, currentLayer)
            const actor = yield* Current.get("ada").pipe(
              Actor.tenant(tenant),
              Effect.provideContext(context),
            )
            yield* actor.Set("seen")
            expect(yield* actor.Show()).toBe("Ada|King Lovelace|seen")
            expect(yield* sql`SELECT cold_ref FROM actor_generations`).toEqual([{ cold_ref: null }])
            expect(yield* sql`SELECT key FROM actor_state ORDER BY key`).toEqual([
              { key: "$version" },
              { key: "first" },
              { key: "last" },
              { key: "tags" },
            ])
            expect(
              yield* sql`SELECT state_version FROM actor_placements WHERE actor_type = 'ColdProfile'`,
            ).toEqual([{ state_version: 2 }])
          }),
        )
      }).pipe(Effect.scoped),
    ))

  it("keeps an old cold reference readable after rehydration and restores the complete stopped snapshot with a higher fence", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const url = yield* database
        const base = ColdStorage.memory()
        const store = {
          ...base,
          list: (prefix: string) =>
            base.list(prefix).pipe(Stream.map((object) => ({ ...object, createdAtMs: 0 }))),
        }
        const backup = yield* Effect.scoped(
          Effect.gen(function* () {
            const { cold, pointer, sql } = yield* openCold(url, store)
            const actor = yield* cold("restore")
            const [receipt] = yield* sql<{
              command_id: string
            }>`SELECT command_id FROM actor_receipts`
            return {
              tenant: actor.ref.tenant,
              pointer: yield* pointer("restore"),
              seedId: receipt!.command_id,
            }
          }),
        )
        const snapshot = yield* disposableDatabase({
          url,
          prefix: "restored",
          template: new URL(Redacted.value(url)).pathname.slice(1),
        })
        const id = yield* Effect.scoped(
          Effect.gen(function* () {
            const { context, test, tier, sql } = yield* openCold(url, store)
            const actor = yield* ColdLedger.get("restore").pipe(
              Actor.tenant(backup.tenant),
              Effect.provideContext(context),
            )
            const now = (yield* test.now).epochMilliseconds
            const id = `v1.${now}.${now + 86_400_000}.b71c83f2-dd59-4b4a-901b-4b9acd81447a`
            expect(yield* actor.Add(7).pipe(Actor.commandId(id))).toBe(24)
            expect(yield* actor.Add(11)).toBe(35)
            expect(yield* tier!.sweep(true)).toBe(0)
            expect(yield* sql`SELECT count(*)::int AS n FROM actor_cold_garbage`).toEqual([
              { n: 1 },
            ])
            return id
          }),
        )
        expect(yield* base.get(backup.pointer.cold_ref!)).toBeInstanceOf(Uint8Array)
        const { context, sql, test } = yield* openCold(snapshot, store)
        expect(yield* sql`SELECT cold_ref, generation::text FROM actor_generations`).toEqual([
          { cold_ref: backup.pointer.cold_ref, generation: backup.pointer.generation },
        ])
        const actor = yield* ColdLedger.get("restore").pipe(
          Actor.tenant(backup.tenant),
          Effect.provideContext(context),
        )
        expect(yield* actor.Seed().pipe(Actor.commandId(backup.seedId))).toBe(17)
        expect(yield* sql`SELECT cold_ref FROM actor_generations`).toEqual([
          { cold_ref: backup.pointer.cold_ref },
        ])
        expect(yield* actor.Add(7).pipe(Actor.commandId(id))).toBe(24)
        expect(yield* actor.Add(7).pipe(Actor.commandId(id))).toBe(24)
        expect(yield* actor.Read()).toEqual({
          total: 24,
          untouched: 43,
          first: "A|BC",
          second: "DZ",
        })
        expect(yield* test.inspect(actor.ref)).toMatchObject({
          receipts: 2,
          events: 1,
          blobs: { archive: 2 },
        })
        const [row] = yield* sql<{
          generation: string
        }>`SELECT generation::text FROM actor_generations`
        expect(BigInt(row!.generation)).toBeGreaterThan(BigInt(backup.pointer.generation))
      }).pipe(Effect.scoped),
    ))
})
