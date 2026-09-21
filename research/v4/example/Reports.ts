// The escape hatch: cross-actor reads are plain SQL over the same tables, through `Database`.
import { Context, Effect, Layer } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Database } from "../framework/Actor.ts"

export class Reports extends Context.Service<Reports, {
  readonly messagesPerRoom: Effect.Effect<ReadonlyArray<{ readonly room: string; readonly count: number }>, SqlError>
}>()("app/Reports") {}

export const ReportsLive = Layer.effect(
  Reports,
  Effect.map(Database, ({ sql }) => ({
    // `tenant_id` / `actor_id` are the columns `Actor.table` adds: the actor id is the room id
    messagesPerRoom: sql<{ room: string; count: number }>`SELECT actor_id AS room, count(*)::int AS count FROM chat_messages GROUP BY actor_id`
  }))
)
