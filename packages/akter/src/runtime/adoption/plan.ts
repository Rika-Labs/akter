import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { adoptionTargets, qualifiedName, type AdoptionTarget } from "./target.ts"

/** What `durable adopt plan` reports for one table; it changes nothing. */
export interface AdoptionPlan {
  readonly table: string
  readonly actor: string
  readonly access: "write" | "read"
  /** Reasons the table cannot be adopted as declared; observe and enforce refuse while any remain. */
  readonly problems: ReadonlyArray<string>
  /** Conditions the operator should know about that do not stop adoption. */
  readonly warnings: ReadonlyArray<string>
  readonly foreignKeys: ReadonlyArray<string>
  readonly triggers: ReadonlyArray<string>
  readonly rules: ReadonlyArray<string>
  readonly views: ReadonlyArray<string>
  readonly owner: string
  /** Roles holding a write privilege, which `enforce` revokes except for the writer and `--allow` roles. */
  readonly writers: ReadonlyArray<string>
  /** The statement that adds the index every scoped statement needs, or undefined when one exists. */
  readonly indexSql: string | undefined
  /** The SQL each later step would run. */
  readonly steps: ReadonlyArray<string>
}

interface ColumnRow {
  readonly name: string
  readonly type: string
  readonly deterministic: boolean | null
  readonly not_null: boolean
}

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`

/** `"schema"."table"`, quoted for the SQL the CLI prints and runs. */
export const quotedTable = (target: Pick<AdoptionTarget, "schema" | "table">) =>
  `${identifier(target.schema)}.${identifier(target.table)}`

/** The index columns a scoped statement leads with: `routing_key` first when the runtime writes the table. */
export const ownerIndexColumns = (
  target: Pick<AdoptionTarget, "access" | "tenantColumn" | "actorColumn">,
) => [
  ...(target.access === "write" ? ["routing_key"] : []),
  target.tenantColumn,
  target.actorColumn,
]

/** The statement that adds an index leading with the mapped columns. */
export const ownerIndexSql = (
  target: Pick<AdoptionTarget, "schema" | "table" | "access" | "tenantColumn" | "actorColumn">,
) =>
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${identifier(`${target.table}_durable_owner`)} ON ${quotedTable(target)} (${ownerIndexColumns(target).map(identifier).join(", ")})`

/**
 * The problems that stop a table from being adopted as declared: it must
 * exist, its mapped columns must exist, and they must be text, varchar, or uuid
 * with a deterministic collation. Shared by `plan` and `observe`.
 */
export const mappingProblems = Effect.fnUntraced(function* (target: AdoptionTarget) {
  const sql = yield* SqlClient.SqlClient

  const exists = yield* sql`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${target.schema} AND c.relname = ${target.table} AND c.relkind IN ('r', 'p')`

  if (exists.length === 0) return [`${qualifiedName(target)} does not exist`]

  const columns = yield* sql<ColumnRow>`
    SELECT a.attname AS name, t.typname AS type, co.collisdeterministic AS deterministic,
      a.attnotnull AS not_null
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0
    WHERE n.nspname = ${target.schema} AND c.relname = ${target.table}
      AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname IN (${target.tenantColumn}, ${target.actorColumn})`

  const problems: Array<string> = []

  for (const [role, name, kind] of [
    ["tenant", target.tenantColumn, target.tenantKind],
    ["actor", target.actorColumn, target.actorKind],
  ] as const) {
    const column = columns.find((candidate) => candidate.name === name)

    if (column === undefined) {
      problems.push(`${role} column ${name} does not exist in ${qualifiedName(target)}`)
      continue
    }

    if (column.type === "citext" || !["text", "varchar", "uuid"].includes(column.type)) {
      problems.push(
        `${role} column ${name} is ${column.type}; only text, varchar, and uuid columns can be mapped`,
      )
      continue
    }

    if ((column.type === "uuid") !== (kind === "uuid"))
      problems.push(`${role} column ${name} is ${column.type} but is declared as a ${kind} column`)

    if (column.deterministic === false)
      problems.push(`${role} column ${name} has a nondeterministic collation`)
  }

  return problems
})

const tableOid = (target: Pick<AdoptionTarget, "schema" | "table">) =>
  `(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${target.schema.replaceAll("'", "''")}' AND c.relname = '${target.table.replaceAll("'", "''")}')`

const hasOwnerIndex = Effect.fnUntraced(function* (
  target: Pick<AdoptionTarget, "schema" | "table" | "access" | "tenantColumn" | "actorColumn">,
) {
  const sql = yield* SqlClient.SqlClient
  const expected = ownerIndexColumns(target)

  const leading = yield* sql.unsafe<{ columns: ReadonlyArray<string> }>(
    `SELECT array_agg(a.attname ORDER BY k.ord) AS columns
     FROM pg_index i
     JOIN pg_class ic ON ic.oid = i.indexrelid
     JOIN pg_am am ON am.oid = ic.relam AND am.amname = 'btree'
     CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indrelid = ${tableOid(target)} AND i.indpred IS NULL AND i.indexprs IS NULL
       AND k.ord <= ${expected.length}
     GROUP BY i.indexrelid`,
  )

  return leading.some(
    (index) => index.columns.length === expected.length && index.columns.join() === expected.join(),
  )
})

/** True when an index leading with the mapped columns exists, so scoped statements do not scan the table. */
export const ownerIndexExists = hasOwnerIndex

/**
 * Reads the catalog for every adopted table of `actors` and reports what
 * adoption would meet, and the SQL each step would run. Changes nothing.
 */
export const planAdoption = Effect.fnUntraced(function* (
  actors: ReadonlyArray<WeakKey>,
  only?: string,
) {
  const sql = yield* SqlClient.SqlClient
  const plans: Array<AdoptionPlan> = []

  for (const target of yield* adoptionTargets(actors, only)) {
    const name = qualifiedName(target)
    const problems = [...(yield* mappingProblems(target))]
    const warnings: Array<string> = []
    const exists = !problems.some((problem) => problem.endsWith("does not exist"))

    if (!exists) {
      plans.push({
        table: name,
        actor: target.actor,
        access: target.access,
        problems,
        warnings,
        foreignKeys: [],
        triggers: [],
        rules: [],
        views: [],
        owner: "",
        writers: [],
        indexSql: undefined,
        steps: [],
      })
      continue
    }

    const oid = tableOid(target)

    const foreign = yield* sql.unsafe<{
      name: string
      definition: string
      incoming: boolean
      delete_action: string
    }>(
      `SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition,
         con.confrelid = ${oid} AS incoming, con.confdeltype AS delete_action
       FROM pg_constraint con
       WHERE con.contype = 'f' AND (con.conrelid = ${oid} OR con.confrelid = ${oid})
       ORDER BY con.conname`,
    )

    const triggers = yield* sql.unsafe<{ name: string }>(
      `SELECT tgname AS name FROM pg_trigger
       WHERE tgrelid = ${oid} AND NOT tgisinternal AND tgname NOT LIKE 'actor\\_adoption\\_%'
       ORDER BY tgname`,
    )

    const rules = yield* sql.unsafe<{ name: string }>(
      `SELECT rulename AS name FROM pg_rules
       WHERE schemaname = '${target.schema.replaceAll("'", "''")}'
         AND tablename = '${target.table.replaceAll("'", "''")}'
       ORDER BY rulename`,
    )

    const views = yield* sql.unsafe<{ name: string }>(
      `SELECT DISTINCT vn.nspname || '.' || v.relname AS name
       FROM pg_depend d
       JOIN pg_rewrite r ON r.oid = d.objid
       JOIN pg_class v ON v.oid = r.ev_class AND v.relkind = 'v'
       JOIN pg_namespace vn ON vn.oid = v.relnamespace
       WHERE d.refobjid = ${oid} AND d.classid = 'pg_rewrite'::regclass
       ORDER BY 1`,
    )

    const owner = (yield* sql.unsafe<{ name: string }>(
      `SELECT r.rolname AS name FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
       WHERE c.oid = ${oid}`,
    ))[0]!.name

    const writers = yield* sql.unsafe<{ name: string }>(
      `SELECT r.rolname AS name FROM pg_roles r
       WHERE r.rolname !~ '^pg_' AND has_table_privilege(r.oid, ${oid}, 'INSERT, UPDATE, DELETE, TRUNCATE')
       ORDER BY r.rolname`,
    )

    const keyless = target.primaryKey.length === 0 && target.access === "write"

    if (keyless) problems.push(`${name} has no primary key, which upserts and backfill need`)

    for (const column of [target.tenantColumn, target.actorColumn]) {
      const notNull = yield* sql.unsafe<{ not_null: boolean }>(
        `SELECT attnotnull AS not_null FROM pg_attribute
         WHERE attrelid = ${oid} AND attname = '${column.replaceAll("'", "''")}'`,
      )

      if (notNull[0]?.not_null === false)
        warnings.push(
          `${column} is nullable; enforce adds a check constraint and refuses rows with NULL`,
        )
    }

    for (const key of foreign) {
      if (key.incoming) continue

      if (target.access === "write")
        warnings.push(
          `foreign key ${key.name} from ${name} to a shared parent adds multixact contention on a high-volume actor table`,
        )

      if (key.delete_action === "c" || key.delete_action === "n")
        warnings.push(
          `foreign key ${key.name} of ${name} has ${key.delete_action === "c" ? "ON DELETE CASCADE" : "ON DELETE SET NULL"} on its parent, so a parent delete would change this table as its owner; enforce refuses until it is resolved`,
        )
    }

    const indexed = yield* hasOwnerIndex(target)
    const index = indexed ? undefined : ownerIndexSql(target)

    if (index !== undefined)
      warnings.push(
        `no index leads with (${ownerIndexColumns(target).join(", ")}); every scoped statement scans the table and startup refuses`,
      )

    const quoted = quotedTable(target)

    const indexSteps = index === undefined ? [] : [index]

    const steps =
      target.access === "read"
        ? indexSteps
        : [
            ...indexSteps,
            `ALTER TABLE ${quoted} ADD COLUMN IF NOT EXISTS routing_key bigint`,
            `CREATE TRIGGER actor_adoption_observe_insert AFTER INSERT ON ${quoted} REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION actor_adoption_observe()`,
            `CREATE TRIGGER actor_adoption_observe_update AFTER UPDATE ON ${quoted} REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION actor_adoption_observe()`,
            `CREATE TRIGGER actor_adoption_observe_delete AFTER DELETE ON ${quoted} REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION actor_adoption_observe()`,
            `CREATE TRIGGER actor_adoption_observe_truncate AFTER TRUNCATE ON ${quoted} FOR EACH STATEMENT EXECUTE FUNCTION actor_adoption_observe()`,
          ]

    plans.push({
      table: name,
      actor: target.actor,
      access: target.access,
      problems,
      warnings,
      foreignKeys: foreign.map((key) => `${key.name}: ${key.definition}`),
      triggers: triggers.map(({ name }) => name),
      rules: rules.map(({ name }) => name),
      views: views.map(({ name }) => name),
      owner,
      writers: writers.map(({ name }) => name),
      indexSql: index,
      steps,
    })
  }

  return plans
})

/** What `plan` prints: one block per table. */
export const formatAdoptionPlan = (plan: AdoptionPlan) =>
  [
    `${plan.table} (${plan.actor}, ${plan.access === "read" ? "read only" : "writable"})`,
    ...plan.problems.map((problem) => `  problem: ${problem}`),
    ...plan.warnings.map((warning) => `  warning: ${warning}`),
    ...(plan.owner === "" ? [] : [`  owner: ${plan.owner}`]),
    ...(plan.writers.length === 0 ? [] : [`  roles that can write: ${plan.writers.join(", ")}`]),
    ...plan.foreignKeys.map((key) => `  foreign key ${key}`),
    ...plan.triggers.map((trigger) => `  existing trigger ${trigger}`),
    ...plan.rules.map((rule) => `  existing rule ${rule}`),
    ...plan.views.map((view) => `  view over the table: ${view}`),
    ...plan.steps.map((step) => `  ${step};`),
  ].join("\n")
