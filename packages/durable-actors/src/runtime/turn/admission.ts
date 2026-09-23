import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ActorError, CommandExpired, InvalidCommandId } from "../../errors/actor.ts"
import { CommandId, commandTimes } from "../../identity/command.ts"

export const databaseTime = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const rows = yield* sql<{
    now: string
  }>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now`

  return Number(rows[0]!.now)
})

export const checkIdentity = Effect.fnUntraced(function* (
  id: string,
  windowMs: number,
  now: number,
) {
  yield* Schema.decodeEffect(CommandId)(id).pipe(
    Effect.mapError(() => ActorError.make({ reason: InvalidCommandId.make({ commandId: id }) })),
  )
  const { issuedAt, expiresAt } = commandTimes(id)

  if (expiresAt - issuedAt !== windowMs || issuedAt > now) {
    return yield* ActorError.make({ reason: InvalidCommandId.make({ commandId: id }) })
  }

  if (now >= expiresAt)
    return yield* ActorError.make({ reason: CommandExpired.make({ commandId: id }) })
})
