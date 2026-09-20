import * as Context from "effect/Context"
import type * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Actor-scoped SQL capability declaration only.
 * No Layer is provided: transaction/fence binding is an implementation gate.
 * Raw SQL must not bypass the future turn or modify reserved runtime tables.
 */
export class Database extends Context.Service<Database, SqlClient.SqlClient>()(
  "@durable-actors/core/Database",
) {}
