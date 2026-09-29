import type { Statement } from "effect/unstable/sql"

export interface RecordedStatement {
  /** The compiled text, whitespace collapsed. */
  readonly sql: string
  /** The parameters of the first run of this text. */
  readonly params: ReadonlyArray<unknown>
}

/**
 * Tables that hold one row per deployment, per actor type, or per runner
 * rather than per actor, so no `routing_key` names them. Cluster's own
 * `cluster_*` tables are the same: they stay together in one shard group.
 */
export const REGISTRY_TABLES: ReadonlySet<string> = new Set([
  "actor_deployment",
  "actor_placements",
  "actor_migrations",
  "actor_payload_versions",
  "actor_payload_writers",
  "actor_routed_subscriptions",
  "actor_content_types",
  "actor_tables",
])

export type StatementScope =
  /** Reads no table: a clock, a setting, or a transaction command. */
  | "table-free"
  /** Names a `routing_key` in a predicate or an insert list. */
  | "keyed"
  /** Probes an index range of `bucket`, the top bits of `routing_key`, without naming a key. */
  | "scan"
  /** Touches only per-deployment tables. */
  | "registry"
  /** Touches a table without naming a routing key. */
  | "unkeyed"

const collapse = (sql: string) => sql.replace(/\s+/g, " ").trim()

/**
 * The tables a statement names: `INTO t (columns)` and `UPDATE t SET` name a
 * table, while `FROM f(...)` names a function.
 */
const tablesOf = (sql: string) => {
  const defined = new Set(
    Array.from(sql.matchAll(/(?:\bwith\b|,)\s*([a-z_]\w*)\s*(?:\([^)]*\))?\s+as\s*\(/gi), (match) =>
      match[1]!.toLowerCase(),
    ),
  )

  const named = [
    ...sql.matchAll(/\b(?:into|update)\s+"?([a-z_]\w*)"?(?![\w"])/gi),
    ...sql.matchAll(/\b(?:from|join)\s+"?([a-z_]\w*)"?(?![\w"]|\s*\()/gi),
  ]

  return new Set(
    named.flatMap((match) => {
      const name = match[1]!.toLowerCase()

      return defined.has(name) || name === "only" ? [] : [name]
    }),
  )
}

export const scopeOf = (sql: string): StatementScope => {
  const tables = tablesOf(sql)

  if (tables.size === 0) return "table-free"

  if (/\bbucket"?\s*(?:=|<|>|between\b|in\b)/i.test(sql)) return "scan"

  if (/\brouting_key"?\s*(?:=|<|>|in\b|between\b|any\b)/i.test(sql)) return "keyed"

  if (/\(\s*"?routing_key"?\s*,/i.test(sql)) return "keyed"

  if (
    Array.from(tables).every((table) => REGISTRY_TABLES.has(table) || table.startsWith("cluster_"))
  )
    return "registry"

  return "unkeyed"
}

/** The statements the runtime compiled while recording, first sighting of each text. */
export interface StatementLog {
  recording: boolean
  readonly seen: Map<string, RecordedStatement>
  readonly observe: (statement: Statement.Statement<unknown>) => void
}

export const statementLog = (): StatementLog => {
  const log: StatementLog = {
    recording: false,
    seen: new Map(),
    observe: (statement) => {
      if (!log.recording) return

      const [text, params] = statement.compile()
      const sql = collapse(text)

      if (!log.seen.has(sql)) log.seen.set(sql, { sql, params })
    },
  }

  return log
}
