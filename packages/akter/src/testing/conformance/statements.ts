import type { Tracer } from "effect"
import type { Statement } from "effect/sql"

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
    Array.from(
      sql.matchAll(
        /(?:\bwith\b|,)\s*([a-z_]\w*)\s*(?:\([^)]*\))?\s+as\s*(?:(?:not\s+)?materialized\s*)?\(/gi,
      ),
      (match) => match[1]!.toLowerCase(),
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
  /**
   * The trace a recording keeps, or undefined to keep every statement. The
   * relay's poll pass and other background loops run in traces of their own,
   * so a recording of one delivery and the turn it sends leaves them out and
   * counts them in `elsewhere`, however the runner's fibers interleave.
   */
  trace: string | undefined
  /** Statements compiled while recording in a trace other than `trace`. */
  elsewhere: number
  readonly seen: Map<string, RecordedStatement>
  readonly observe: (statement: Statement.Statement<unknown>, span: Tracer.Span) => void
}

export const statementLog = (): StatementLog => {
  const log: StatementLog = {
    recording: false,
    trace: undefined,
    elsewhere: 0,
    seen: new Map(),
    observe: (statement, span) => {
      if (!log.recording) return

      if (log.trace !== undefined && span.traceId !== log.trace) {
        log.elsewhere += 1
        return
      }

      const [text, params] = statement.compile()
      const sql = collapse(text)

      if (!log.seen.has(sql)) log.seen.set(sql, { sql, params })
    },
  }

  return log
}

const SSL_REQUEST = 80877103
const GSS_REQUEST = 80877104
const SYNC = 0x53
const QUERY = 0x51

/**
 * Counts the statements a client sends on one Postgres connection from its
 * protocol messages, for a relay that sees every byte the client writes:
 * every extended-protocol statement ends its cycle with one Sync, and a
 * simple query is one Query message. The startup and encryption requests
 * that open a connection carry no type byte and are skipped.
 */
export const wireStatements = () => {
  let started = false
  let pending: Buffer = Buffer.alloc(0)

  return (chunk: Buffer) => {
    let statements = 0
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])

    while (true) {
      if (!started) {
        if (pending.length < 8 || pending.length < pending.readInt32BE(0)) return statements

        const code = pending.readInt32BE(4)
        started = code !== SSL_REQUEST && code !== GSS_REQUEST
        pending = pending.subarray(pending.readInt32BE(0))
        continue
      }

      if (pending.length < 5 || pending.length < 1 + pending.readInt32BE(1)) return statements

      if (pending[0] === SYNC || pending[0] === QUERY) statements += 1
      pending = pending.subarray(1 + pending.readInt32BE(1))
    }
  }
}

/**
 * What one external command to a warm activation costs across every pool,
 * derived from the turn's two groups rather than measured. The admission
 * flight sends `BEGIN`, the timeout `set_config`, and the fenced read that
 * resolves the receipt. A command that runs its handler and dirties one key
 * then sends the state upsert, the receipt insert, `COMMIT`, and the read of
 * the commit version and the clock its expiry recheck uses: 2 flights and 7
 * statements. A replay sends `ROLLBACK` and that same read instead: 2 flights
 * and 5 statements. Nothing is read before delivery or after the turn.
 */
export const SERVED_COMMAND = {
  warm: { flights: 2, statements: 7 },
  replay: { flights: 2, statements: 5 },
} as const
