import { Config, Crypto, Effect, Option, Redacted } from "effect"
import { Pool } from "pg"

/** A server with a real Neki router; each test database is an `akter_dev_` database created and dropped on it. */
export const liveNeki = Option.getOrUndefined(
  Option.filter(
    Effect.runSync(Config.option(Config.String("TEST_NEKI_CONTROL_PLANE_URL"))),
    (value) => value !== "",
  ),
)

/**
 * Without a router, a test database is Postgres with a stand-in for Neki's
 * propagation functions, which counts its waits in `neki_barriers` and refuses
 * to run inside a writing transaction, and an event trigger that refuses DDL
 * once its transaction has written. Plain Postgres still shows DDL inside a
 * transaction, so the stand-in rejects a transactional schema change only
 * where Neki would hide its DDL; it is not Neki evidence.
 */
const standIn = `
  CREATE SCHEMA __neki;
  CREATE TABLE neki_barriers (calls integer NOT NULL);
  INSERT INTO neki_barriers VALUES (0);
  CREATE FUNCTION __neki.ddl_versions(OUT schema_version bigint, OUT cluster_version bigint)
    LANGUAGE sql AS $$ SELECT 1::bigint, 1::bigint $$;
  CREATE FUNCTION __neki.wait_for_ddl(schema_version bigint, cluster_version bigint)
    RETURNS void LANGUAGE plpgsql AS $$
  BEGIN
    IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
      RAISE EXCEPTION 'DDL propagation was requested inside a writing transaction';
    END IF;
    UPDATE neki_barriers SET calls = calls + 1;
  END $$;
  CREATE FUNCTION neki_autocommit_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
      RAISE EXCEPTION 'DDL inside a writing transaction: %', tg_tag;
    END IF;
  END $$;
  CREATE EVENT TRIGGER neki_autocommit_ddl ON ddl_command_start
    EXECUTE FUNCTION neki_autocommit_ddl();
`

/** A new, empty database on the live router when one is configured, else on the stand-in; dropped with the scope. */
export const nekiDatabase = Effect.fnUntraced(function* (prefix: string) {
  const server = new URL(liveNeki ?? (yield* Config.String("TEST_DATABASE_URL").pipe(Effect.orDie)))
  const id = (yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "")
  const name = liveNeki === undefined ? `${prefix}_${id}` : `akter_dev_${prefix}_${id.slice(0, 12)}`
  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: server.href, max: 1 })),
    (pool) => Effect.promise(() => pool.end()),
  )
  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () =>
      Effect.promise(() =>
        admin.query(
          `DROP DATABASE IF EXISTS "${name}"${liveNeki === undefined ? " WITH (FORCE)" : ""}`,
        ),
      ),
  )
  server.pathname = `/${name}`
  if (liveNeki === undefined) {
    const pool = new Pool({ connectionString: server.href, max: 1 })
    yield* Effect.promise(() => pool.query(standIn)).pipe(
      Effect.ensuring(Effect.promise(() => pool.end())),
    )
  }
  return Redacted.make(server.href)
})
