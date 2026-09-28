import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { shuffled } from "../../measure.ts"
import { Probe } from "../../probe/contract.ts"
import { type CaseResult, DEFAULT_POOL, measure, type Scenario } from "../../scenario.ts"

const WORKERS = 64

/** Tables whose rows every stored actor keeps for its lifetime, whatever its API. */
const ACTOR_TABLES = ["actor_generations", "actor_state"] as const

/** One row per command until its horizon, so it grows with turns, not with actors. */
const RECEIPTS = "actor_receipts"

interface Size {
  readonly heap: number
  readonly toast: number
  readonly indexes: number
}

/**
 * On-disk bytes of every runtime table: the main fork, its TOAST relation
 * with the TOAST index, and its own indexes. Free-space and visibility maps
 * are left out, because only a vacuum creates them.
 */
const sizes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const rows = yield* sql<{ table: string; heap: string; toast: string; indexes: string }>`
    SELECT c.relname AS table,
      pg_relation_size(c.oid)::text AS heap,
      (CASE WHEN c.reltoastrelid = 0 THEN 0
        ELSE pg_total_relation_size(c.reltoastrelid) END)::text AS toast,
      pg_indexes_size(c.oid)::text AS indexes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname LIKE 'actor\\_%'`.pipe(
    Effect.orDie,
  )

  return new Map<string, Size>(
    rows.map((row) => [
      row.table,
      { heap: Number(row.heap), toast: Number(row.toast), indexes: Number(row.indexes) },
    ]),
  )
})

const grown = (before: Map<string, Size>, after: Map<string, Size>, table: string): Size => {
  const zero = { heap: 0, toast: 0, indexes: 0 }
  const was = before.get(table) ?? zero
  const is = after.get(table) ?? zero

  return {
    heap: is.heap - was.heap,
    toast: is.toast - was.toast,
    indexes: is.indexes - was.indexes,
  }
}

const total = (size: Size) => size.heap + size.toast + size.indexes

const per = (bytes: number, units: number) => Math.round((bytes / units) * 10) / 10

/** Mean stored bytes of the probe's encoded state value, which the hypothesis counts separately. */
const stateValueBytes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* sql<{ bytes: string }>`
    SELECT coalesce(avg(octet_length(value)), 0)::text AS bytes
    FROM actor_state WHERE actor_type = 'Probe'`.pipe(Effect.orDie)

  return per(Number(row!.bytes), 1)
})

/**
 * Stored bytes per actor after n real first turns. Each case creates n
 * `Probe` actors through one `Add` each and reports how much the runtime
 * tables grew: `extra.bytesPerActor` sums the generation and state rows with
 * their indexes, the quantity the 175–250 B planning hypothesis names, and
 * the per-table fields split it into heap, TOAST, and index bytes. The one
 * receipt each first turn leaves is reported per turn beside it, because
 * receipts expire and grow with commands rather than with actors.
 */
export const storedOverhead: Scenario = {
  name: "stored-overhead",
  description: `Relation and index bytes per stored actor after n first turns (Probe, one Add each, ${WORKERS} callers), split by table, with the receipt each turn leaves reported per turn.`,
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const postgres = context.backend.name === "postgres"
      const counts = quick ? [1000] : postgres ? [10_000, 100_000] : [10_000]
      const results: Array<CaseResult> = []

      for (const actors of counts)
        results.push(
          yield* context.withRuntime(
            { maxResidentActors: Math.max(actors, 10_000) },
            (instruments) =>
              Effect.gen(function* () {
                const order = shuffled(actors)
                const before = yield* sizes

                const result = yield* measure({
                  name: `actors-${actors}`,
                  parameters: {
                    actors,
                    workers: WORKERS,
                    pool: DEFAULT_POOL,
                    turnsPerActor: 1,
                  },
                  instruments,
                  workers: WORKERS,
                  operations: actors,
                  operation: (index) =>
                    Probe.get(`actor-${order[index]!}`).pipe(
                      Effect.flatMap((probe) => probe.Add(1)),
                    ),
                })

                const after = yield* sizes

                const split = ACTOR_TABLES.map(
                  (table) => [table.replace("actor_", ""), grown(before, after, table)] as const,
                )

                const receipts = grown(before, after, RECEIPTS)

                const perTable = Object.fromEntries(
                  split.flatMap(([name, size]) => [
                    [`${name}HeapBytesPerActor`, per(size.heap, actors)],
                    [`${name}ToastBytesPerActor`, per(size.toast, actors)],
                    [`${name}IndexBytesPerActor`, per(size.indexes, actors)],
                  ]),
                )

                const others = [...after.keys()].filter(
                  (table) =>
                    table !== RECEIPTS &&
                    !ACTOR_TABLES.some((actorTable) => actorTable === table) &&
                    total(grown(before, after, table)) !== 0,
                )

                return {
                  ...result,
                  extra: {
                    bytesPerActor: per(
                      split.reduce((sum, [, size]) => sum + total(size), 0),
                      actors,
                    ),
                    stateValueBytes: yield* stateValueBytes,
                    receiptBytesPerTurn: per(total(receipts), actors),
                    ...perTable,
                    otherTablesGrown: others.join(" ") || "none",
                  },
                }
              }),
          ),
        )

      return results
    }),
}
