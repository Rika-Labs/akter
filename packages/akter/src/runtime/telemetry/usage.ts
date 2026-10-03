import { Context, Effect } from "effect"
import type { SqlClient, SqlError } from "effect/sql"
import type { ActorRef } from "../../identity/caller.ts"

/** Commands whose receipts one turn commit newly inserted. */
export interface UsageCommands {
  readonly ref: ActorRef
  readonly commandIds: ReadonlyArray<string>
  /** The runtime's client for this turn: its statement reaches the turn's own transaction. */
  readonly sql: SqlClient.SqlClient
}

/** A query's answer the runtime is about to return. */
export interface UsageRead {
  readonly ref: ActorRef
  /**
   * Identifies one read attempt across a watch's reruns. A watch without one
   * is not recorded.
   */
  readonly requestToken?: string | undefined
  readonly watch: boolean
  /** The primary database's client. */
  readonly sql: SqlClient.SqlClient
}

/** The hooks of `UsageAccounting`. */
export interface UsageAccountingService {
  readonly commands: (input: UsageCommands) => Effect.Effect<void, SqlError.SqlError>
  readonly read: (input: UsageRead) => Effect.Effect<void, SqlError.SqlError>
}

/**
 * An optional hook that lets a host account for the work its actors do
 * without the framework owning any accounting tables. The default does
 * nothing, so a self-hosted runtime pays no cost.
 *
 * `commands` is queued in the turn's commit group directly after the
 * receipt insert, so its rows commit or roll back with the receipts. The
 * group is pipelined: the returned effect must issue exactly one statement on
 * the given `sql`, because a second one could be sent after the group's
 * `COMMIT`. It sees only commands whose receipts are new; a replay never
 * reaches it.
 *
 * `read` runs on the primary after the query's final access check and before
 * a non-defect outcome is returned. A failure of either hook fails the work
 * it accounts for.
 */
export const UsageAccounting = Context.Reference<UsageAccountingService>(
  "@rikalabs/akter/runtime/telemetry/usage/UsageAccounting",
  { defaultValue: () => ({ commands: () => Effect.void, read: () => Effect.void }) },
)
