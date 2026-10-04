import { Context, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ActorError, CommandExpired, InvalidCommandId } from "../../errors/actor.ts"
import { CommandId, commandTimes } from "../../identity/command.ts"

/**
 * Shifts the framework clock: command ids, their expiry, timers, event
 * timestamps, and retention all read database time plus this offset. Only
 * `ActorTest.advance` moves it, so every one of them moves together.
 */
export const FrameworkClock = Context.Reference<{ readonly offsetMillis: () => number }>(
  "akter/FrameworkClock",
  { defaultValue: () => ({ offsetMillis: () => 0 }) },
)

/** The database clock as the framework sees it, in epoch milliseconds. */
export const databaseTime = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const clock = yield* FrameworkClock

  const rows = yield* sql<{
    now: string
  }>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now`

  return Number(rows[0]!.now) + clock.offsetMillis()
})

const decodeCommandId = Schema.decodeEffect(CommandId)

/** Matches a versioned command id this runner cannot read: `v<n>.` for any n other than 1. */
const OTHER_VERSION = /^v(?!1\.)\d{1,9}\./

/**
 * Validates a command id against the admission clock. Fails with `ActorError`:
 * `InvalidCommandId` when the id is not a version-1 id (`version` for another
 * version, `malformed` otherwise), its window differs from `windowMs`
 * (`window`), or it is issued after `now` (`future`); `CommandExpired` once
 * `now` reaches its expiry. All times are epoch milliseconds. Without `now`
 * only the id's form and window are checked, which needs no clock read.
 */
export const checkIdentity = Effect.fnUntraced(function* (
  id: string,
  windowMs: number,
  now?: number,
) {
  const invalid = (code: InvalidCommandId["code"]) =>
    ActorError.make({ reason: InvalidCommandId.make({ commandId: id, code }) })

  yield* decodeCommandId(id).pipe(
    Effect.mapError(() => invalid(OTHER_VERSION.test(id) ? "version" : "malformed")),
  )
  const { issuedAt, expiresAt } = commandTimes(id)

  if (expiresAt - issuedAt !== windowMs) return yield* invalid("window")

  if (now === undefined) return

  if (issuedAt > now) return yield* invalid("future")

  if (now >= expiresAt)
    return yield* ActorError.make({ reason: CommandExpired.make({ commandId: id }) })
})
