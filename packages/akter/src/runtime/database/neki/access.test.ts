import { BunCrypto } from "@effect/platform-bun"
import {
  Cause,
  Config,
  Context,
  Crypto,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { Actor } from "../../../index.ts"
import { Actors, Database, NekiTopologyAccessDenied } from "../../index.ts"
import { disposableDatabase } from "../../../testing/database.ts"
import { currentRanges, ShardDirectory } from "../shards.ts"
import { TurnGroups } from "../../turn/group.ts"
import { decompress } from "../../storage/codec.ts"
import { routedTables } from "./topology.ts"

const harness = ManagedRuntime.make(BunCrypto.layer)
afterAll(() => harness.dispose())

/** A real PostgreSQL role lacks EXECUTE on existing topology functions, not a mocked SQL client. */
const restrictedDatabase = Effect.gen(function* () {
  const server = yield* Config.Redacted("TEST_DATABASE_URL")
  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: Redacted.value(server), max: 1 })),
    (pool) => Effect.promise(() => pool.end()),
  )
  const role = `neki_runtime_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`
  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE ROLE "${role}" NOLOGIN NOINHERIT`)),
    () => Effect.promise(() => admin.query(`DROP ROLE "${role}"`)),
  )
  const url = yield* disposableDatabase({ url: server })
  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: Redacted.value(url), max: 1 })),
    (pool) => Effect.promise(() => pool.end()),
  )
  yield* Effect.promise(() =>
    pool.query(`
    ALTER DATABASE "${new URL(Redacted.value(url)).pathname.slice(1)}" OWNER TO "${role}";
    CREATE SCHEMA __neki;
    GRANT USAGE ON SCHEMA __neki TO "${role}";
    GRANT USAGE, CREATE ON SCHEMA public TO "${role}";
    CREATE FUNCTION __neki.get_data_topology(OUT data_topology_json text)
      LANGUAGE sql AS $$ SELECT '{"default_shard_group":"authority","shard_groups":[{"uid":"authority","key_ranges":[{"shard_uid":"sh1"}]}]}'::text $$;
    CREATE FUNCTION __neki.get_data_topology_revision() RETURNS bigint LANGUAGE sql AS $$ SELECT 7::bigint $$;
    REVOKE EXECUTE ON FUNCTION __neki.get_data_topology(), __neki.get_data_topology_revision() FROM PUBLIC;
    CREATE TABLE public.neki_barriers (calls integer NOT NULL);
    INSERT INTO public.neki_barriers VALUES (0);
    CREATE FUNCTION __neki.ddl_versions(OUT schema_version bigint, OUT cluster_version bigint)
      LANGUAGE sql AS $$ SELECT 1::bigint, 1::bigint $$;
    CREATE FUNCTION __neki.wait_for_ddl(schema_version bigint, cluster_version bigint) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
    BEGIN
      IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
        RAISE EXCEPTION 'DDL propagation was requested inside a writing transaction';
      END IF;
      UPDATE public.neki_barriers SET calls = calls + 1;
    END $$;
  `),
  )
  return { url, role, pool }
})

const Result = Schema.Struct({
  count: Schema.Int,
  mode: Schema.String,
  fanout: Schema.String,
  target: Schema.NullOr(Schema.String),
})
const Add = Actor.command("Add", { payload: Schema.Int, success: Result })
class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}
const Fail = Actor.command("Fail", { error: Refused })
const Counter = Actor.make("UnroutedCounter", {
  key: Schema.String,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Add, Fail },
})
const counter = Counter.toLayer(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return {
      Fail: () =>
        Effect.gen(function* () {
          const turn = yield* Counter.Turn
          yield* turn.state.set({ count: -900 })
          return yield* Refused.make({})
        }),
      Add: (amount) =>
        Effect.gen(function* () {
          const turn = yield* Counter.Turn
          const count = turn.state.count + amount
          yield* turn.state.set({ count })
          const [settings] = yield* sql<
            typeof Result.Type
          >`SELECT current_setting('__neki.tx_mode', true) AS mode,
        current_setting('__neki.fanout', true) AS fanout, current_setting('__neki.shard', true) AS target`.pipe(
            Effect.orDie,
          )
          return { count, mode: settings!.mode, fanout: settings!.fanout, target: settings!.target }
        }),
    }
  }),
)

describe("Neki topology access on real Postgres", () => {
  for (const privilege of ["topology", "revision"] as const)
    it(`refuses default Neki startup with a typed failure when ${privilege} EXECUTE is missing`, () =>
      harness.runPromise(
        Effect.gen(function* () {
          const { url, role, pool } = yield* restrictedDatabase
          if (privilege === "revision")
            yield* Effect.promise(() =>
              pool.query(`GRANT EXECUTE ON FUNCTION __neki.get_data_topology() TO "${role}"`),
            )
          const exit = yield* Effect.exit(
            Layer.build(Database.postgres({ url, neki: true, startupParameters: { role } })),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.hasDies(exit.cause)).toBe(false)
            const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
            expect(error).toBeInstanceOf(NekiTopologyAccessDenied)
            expect(String(error)).toContain('neki: { routing: "none" }')
            expect(String(error)).toContain("EXECUTE")
            expect(String(error)).toContain("__neki.get_data_topology_revision()")
          }
          expect(
            (yield* Effect.promise(() =>
              pool.query("SELECT to_regclass('actor_state') AS table_name"),
            )).rows,
          ).toEqual([{ table_name: null }])
        }).pipe(Effect.scoped),
      ))

  it(
    "boots, migrates and persists turns in explicit unrouted mode without topology access",
    () =>
      harness.runPromise(
        Effect.gen(function* () {
          const { url, role, pool } = yield* restrictedDatabase
          const database = Database.postgres({
            url,
            neki: { routing: "none" },
            startupParameters: { role },
            offTurnConnections: 3,
            maxConnections: 1,
          })
          const context = yield* Layer.build(
            counter.pipe(Layer.provideMerge(Actors.layer()), Layer.provideMerge(database)),
          )
          expect(Context.get(context, Database.Neki)).toBe(true)
          expect(Context.getOption(context, ShardDirectory)._tag).toBe("None")
          expect(Context.getOption(context, TurnGroups)._tag).toBe("None")
          yield* Effect.gen(function* () {
            expect(yield* currentRanges).toEqual([{ first: -128, last: 127 }])
            expect(yield* routedTables(["actor_state", "actor_receipts"])).toEqual([])
            const actor = yield* Counter.get("asymmetric")
            expect(yield* actor.Add(13)).toEqual({
              count: 13,
              mode: "single",
              fanout: "single",
              target: null,
            })
            const failure = yield* Effect.exit(actor.Fail())
            expect(Exit.isFailure(failure) && Cause.squash(failure.cause)).toEqual(Refused.make({}))
            expect(yield* actor.Add(-4)).toEqual({
              count: 9,
              mode: "single",
              fanout: "single",
              target: null,
            })
          }).pipe(Effect.provideContext(context))
          const barriers = yield* Effect.promise(() =>
            pool.query("SELECT calls FROM neki_barriers"),
          )
          expect(barriers.rows[0].calls).toBeGreaterThan(0)
          expect(
            (yield* Effect.promise(() =>
              pool.query("SELECT count(*)::int AS receipts FROM actor_receipts"),
            )).rows,
          ).toEqual([{ receipts: 3 }])
          const stored = yield* Effect.promise(() =>
            pool.query("SELECT value FROM actor_state WHERE key = 'count'"),
          )
          expect(stored.rows).toHaveLength(1)
          expect(
            yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Int))(
              decompress(stored.rows[0].value),
            ),
          ).toBe(9)
        }).pipe(Effect.scoped),
      ),
    60_000,
  )

  it("refuses a replica in explicit unrouted mode", () => {
    expect(() => Database.postgres({ neki: { routing: "none" }, replica: {} })).toThrow(
      "A Neki database has no commit version",
    )
  })

  it("keeps reading a live directory and revision in default mode when privileges are granted", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const { url, role, pool } = yield* restrictedDatabase
        yield* Effect.promise(() =>
          pool.query(
            `GRANT EXECUTE ON FUNCTION __neki.get_data_topology(), __neki.get_data_topology_revision() TO "${role}"`,
          ),
        )
        const context = yield* Layer.build(
          Database.postgres({ url, neki: true, startupParameters: { role } }),
        )
        const directory = Option.getOrThrow(Context.getOption(context, ShardDirectory))
        expect(yield* directory.revision).toBe("7")
        expect(yield* directory.ranges).toEqual([{ first: -128, last: 127 }])
        yield* Effect.promise(() =>
          pool.query(
            "CREATE OR REPLACE FUNCTION __neki.get_data_topology_revision() RETURNS bigint LANGUAGE sql AS $$ SELECT 19::bigint $$",
          ),
        )
        yield* directory.refresh
        expect(yield* directory.revision).toBe("19")
      }).pipe(Effect.scoped),
    ))
})
