import { type Context, type Crypto, Effect, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import type { RegisteredJob } from "../members.ts"
import { Due, emptyOutbox } from "../../handles/intents.ts"
import { ActorRef, type Caller } from "../../identity/caller.ts"
import { VERSION_KEY } from "../../state/migration.ts"
import { TenantScope, withTenant } from "../database/tenancy.ts"
import { compress, routingKey } from "../storage/codec.ts"
import { recordedPlacement } from "../storage/placements.ts"
import { databaseTime, FrameworkClock } from "../turn/admission.ts"
import { OutboxRuntime, outboxStatements } from "../turn/outbox.ts"

/** The only seed format this build writes and reads. */
export const SEED_FORMAT = 1

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * One actor's exported state and pending obligations, with nothing that
 * identifies its tenant, caller, or credentials: a seed is replayed under the
 * tenant and caller of the test that reads it. `dueInMs` is measured from the
 * moment of export, so a replay follows the test's own clock. `omitted` counts
 * what the seed does not carry: receipts, events, workflow executions, dead
 * letters, rows of the actor's owned tables, and its blob entries, so a reader
 * can see what a replay starts without.
 */
export const Seed = Schema.Struct({
  format: Schema.Literal(SEED_FORMAT),
  actor: Schema.Struct({ type: Schema.NonEmptyString, id: Schema.NonEmptyString }),
  created: Schema.Boolean,
  stateVersion: Count,
  state: Schema.Record(Schema.String, Schema.Json),
  intents: Schema.Array(
    Schema.Struct({
      target: Schema.Struct({ actor: Schema.NonEmptyString, id: Schema.NonEmptyString }),
      command: Schema.NonEmptyString,
      payload: Schema.Json,
      key: Schema.optional(Schema.NonEmptyString),
      dueInMs: Count,
    }),
  ),
  jobs: Schema.Array(
    Schema.Struct({
      job: Schema.NonEmptyString,
      payload: Schema.Json,
      payloadVersion: Count,
      key: Schema.optional(Schema.NonEmptyString),
      dueInMs: Count,
    }),
  ),
  omitted: Schema.Struct({
    receipts: Count,
    events: Count,
    workflows: Count,
    deadLetters: Count,
    tableRows: Count,
    blobs: Count,
  }),
})

/** A decoded `Seed`. */
export type Seed = typeof Seed.Type

/** Codec between a `Seed` and the JSON text a seed file holds. */
export const SeedJson = Schema.fromJsonString(Seed)

/** What the runtime's clock and outbox references hold on this runner. */
type ReferenceOf<T> = T extends Context.Reference<infer S> ? S : never

/**
 * Builds the operation that starts an actor from a seed, over the runtime's
 * SQL, crypto, clock, and outbox, and its job registrations.
 *
 * The actor's row, state, and obligations are written in one transaction, so
 * a refused seed leaves nothing behind. It never overwrites: an actor that
 * already has a generation row refuses the seed. Obligations are staged
 * through the turn's own outbox statements under the caller the test runs as,
 * never a caller from the file, so a seed cannot carry authority. A job
 * this runner has no executor for is refused, because it could never run.
 * A seed marking created an actor type that declares no `createdBy` is
 * refused: that marker stays false for such a type, or declaring the policy
 * later would treat the seeded actor as already created.
 */
export const seedRuntime = (deps: {
  readonly services: Context.Context<SqlClient.SqlClient | Crypto.Crypto>
  readonly clock: ReferenceOf<typeof FrameworkClock>
  readonly outbox: ReferenceOf<typeof OutboxRuntime>
  readonly jobOf: (actorType: string, job: string) => RegisteredJob | undefined
  /** Whether the actor type declares `createdBy`. */
  readonly createdBy: (actorType: string) => boolean
  readonly wake: Effect.Effect<void>
  /** The tenant and adoption writer roles the operator's turns take, as the runtime's own turns do. */
  readonly tenantScope: ReferenceOf<typeof TenantScope>
}) =>
  Effect.fnUntraced(
    function* ({
      ref,
      caller,
      seed,
    }: {
      readonly ref: ActorRef
      readonly caller: Caller
      readonly seed: Seed
    }) {
      if (seed.actor.type !== ref.actor)
        return yield* Effect.die(
          new Error(`The seed is of ${seed.actor.type}, not ${ref.actor}: refusing to seed it`),
        )

      if (seed.created && !deps.createdBy(ref.actor))
        return yield* Effect.die(
          new Error(
            `The seed marks ${ref.actor} created, but ${ref.actor} declares no createdBy: refusing to seed it`,
          ),
        )

      for (const { job } of seed.jobs)
        if (deps.jobOf(ref.actor, job) === undefined)
          return yield* Effect.die(
            new Error(`The seed has job ${job}, which ${ref.actor} does not register`),
          )

      const sql = yield* SqlClient.SqlClient
      const placement = yield* recordedPlacement(ref.actor)

      if (placement === undefined)
        return yield* Effect.die(new Error(`Actor ${ref.actor} is not registered`))

      const key = routingKey({ ref, placement })

      yield* withTenant(ref.tenant)(
        sql.withTransaction(
          Effect.gen(function* () {
            const [inserted] = yield* sql<{ created: boolean }>`
            INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id, created)
            VALUES (${key}, ${ref.tenant}, ${ref.actor}, ${ref.id}, ${seed.created})
            ON CONFLICT DO NOTHING
            RETURNING created`

            if (inserted === undefined)
              return yield* Effect.die(
                new Error(
                  `${ref.actor}/${ref.id} already exists: a seed starts an actor, never overwrites one`,
                ),
              )

            const rows: Array<readonly [string, string]> = Object.entries(seed.state).map(
              ([name, value]) => [name, JSON.stringify(value)] as const,
            )

            if (seed.stateVersion > 0) rows.push([VERSION_KEY, String(seed.stateVersion)])

            for (const [name, value] of rows)
              yield* sql`INSERT INTO actor_state (routing_key, tenant_id, actor_type, actor_id, key, value)
              VALUES (${key}, ${ref.tenant}, ${ref.actor}, ${ref.id}, ${name}, ${compress(value)})`

            const staged = yield* outboxStatements(
              key,
              ref,
              {
                ...emptyOutbox,
                intents: seed.intents.map((intent) => ({
                  target: ActorRef.make({
                    tenant: ref.tenant,
                    actor: intent.target.actor,
                    id: intent.target.id,
                  }),
                  command: intent.command,
                  payload: JSON.stringify(intent.payload),
                  caller,
                  due: Due.cases.After.make({ millis: intent.dueInMs }),
                  key: intent.key,
                })),
                jobs: seed.jobs.map((job) => ({
                  job: job.job,
                  payload: JSON.stringify(job.payload),
                  version: job.payloadVersion,
                  caller,
                  due: Due.cases.After.make({ millis: job.dueInMs }),
                  key: job.key,
                  capped: deps.jobOf(ref.actor, job.job)?.perActor !== undefined,
                })),
              },
              databaseTime,
            )

            for (const statement of staged.statements) yield* statement
          }),
        ),
      )

      yield* deps.wake
    },
    (effect) =>
      effect.pipe(
        Effect.catchIf(SqlError.isSqlError, Effect.die),
        Effect.provideService(FrameworkClock, deps.clock),
        Effect.provideService(OutboxRuntime, deps.outbox),
        Effect.provideService(TenantScope, deps.tenantScope),
        Effect.provideContext(deps.services),
      ),
  )
