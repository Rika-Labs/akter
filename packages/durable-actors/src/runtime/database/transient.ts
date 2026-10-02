import { Schema } from "effect"
import type { SqlError } from "effect/sql"

/** The SQLSTATE a Postgres error response carries, as the driver keeps it on the error's cause. */
const ServerResponse = Schema.Struct({ code: Schema.String })

const isServerResponse = Schema.is(ServerResponse)

/**
 * Whether a SQL failure is worth retrying unchanged: the driver says so, or
 * the server refused the statement for its own state. SQLSTATE `57P01`–`57P03`
 * mean an administrator or crash shutdown or a server still starting or in
 * recovery; `53000`–`53300` cover exhausted resources, disk, memory or slots. The
 * driver reports those as unknown, non-retryable errors, but the same
 * statement succeeds once the server is back.
 */
export const transientSqlError = (error: SqlError.SqlError): boolean => {
  if (error.isRetryable) return true

  const cause = error.reason.cause

  return (
    isServerResponse(cause) &&
    (cause.code === "57P01" ||
      cause.code === "57P02" ||
      cause.code === "57P03" ||
      cause.code === "53000" ||
      cause.code === "53100" ||
      cause.code === "53200" ||
      cause.code === "53300")
  )
}
