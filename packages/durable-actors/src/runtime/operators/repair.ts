import { Context, type Crypto, Effect, Option, Schema } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import type { RegisteredEffect } from "../../handles/actors.ts"
import { emptyOutbox } from "../../handles/intents.ts"
import { ActorRef, System } from "../../identity/caller.ts"
import { decodeText, readOnly } from "../inspector/queries.ts"
import * as Queries from "../inspector/queries.ts"
import { withTenant } from "../database/tenancy.ts"
import { type Placement, routingKey } from "../storage/codec.ts"
import { recordedPlacement } from "../storage/placements.ts"
import { databaseTime, FrameworkClock } from "../turn/admission.ts"
import { OutboxRuntime, outboxStatements } from "../turn/outbox.ts"
import {
  type AuditEntry,
  type AuditRecord,
  auditRoutingKey,
  listAudit,
  writeAudit,
} from "./audit.ts"

/** The dead letter, receipt, or actor the request names does not exist. */
export class OperatorNotFound extends Schema.TaggedError<OperatorNotFound>()(
  "OperatorNotFound",
  {},
) {}

/**
 * The dead letter's last attempt may have applied the call. Retrying runs
 * the provider call again under a new idempotency key, so the operator must
 * state that they checked the provider first.
 */
export class ProviderOutcomeUnknown extends Schema.TaggedError<ProviderOutcomeUnknown>()(
  "ProviderOutcomeUnknown",
  { effectId: Schema.String },
) {}

/** This runner has no executor for the effect, so it can't know how to queue a retry. */
export class EffectNotServed extends Schema.TaggedError<EffectNotServed>()("EffectNotServed", {
  effect: Schema.String,
}) {}

export type RepairError = OperatorNotFound | ProviderOutcomeUnknown | EffectNotServed

/** What an actor-scoped operator request names. */
export interface ActorTarget {
  readonly tenant: string
  readonly actorType: string
  readonly actorId: string
}

/** A stored outcome as an operator reads it: never re-executed. */
export interface ReceiptView {
  readonly commandId: string
  readonly command: string
  readonly outcomeTag: string
  readonly outcome: Queries.Decoded | null
  readonly expiresAtMs: number
}

/**
 * Operator reads and repairs that need the runtime's outbox and executors.
 * Every repair writes its audit row in its own transaction.
 */
export class OperatorRuntime extends Context.Service<
  OperatorRuntime,
  {
    /** The actor type's recorded placement, or none when no runner registered it. */
    readonly placement: (actorType: string) => Effect.Effect<Option.Option<Placement>>
    readonly inspect: (
      target: ActorTarget & { readonly limit: number; readonly outcomes: boolean },
    ) => Effect.Effect<Option.Option<unknown>>
    readonly receipt: (
      target: ActorTarget & { readonly commandId: string },
    ) => Effect.Effect<Option.Option<ReceiptView>>
    readonly retry: (request: {
      readonly target: ActorTarget
      readonly effectId: string
      readonly providerChecked: boolean
      readonly audit: AuditEntry
    }) => Effect.Effect<{ readonly effectId: string }, RepairError>
    readonly discard: (request: {
      readonly target: ActorTarget
      readonly effectId: string
      readonly audit: AuditEntry
    }) => Effect.Effect<void, RepairError>
    /** A tenant's newest audit rows, or every tenant's for `"*"`. */
    readonly audit: (page: {
      readonly tenant: string
      readonly limit: number
    }) => Effect.Effect<ReadonlyArray<AuditRecord>>
    /** Writes one audit row on its own; a read's row goes in before its answer. */
    readonly record: (entry: AuditEntry, outcome: Schema.Json) => Effect.Effect<void>
  }
>()("@durable-actors/core/runtime/operators/repair/OperatorRuntime") {}

/** What the runtime's clock and outbox references hold on this runner. */
type ReferenceOf<T> = T extends Context.Reference<infer S> ? S : never

interface DeadLetterRow {
  readonly effect: string
  readonly payload: string
  readonly attempts: number
  readonly cause: string
  readonly ambiguous: boolean
  readonly payloadVersion: number
}

/**
 * Builds the service over the runtime's SQL, crypto, clock, and outbox, and
 * its effect registrations, which say whether a retried effect is capped.
 */
export const operatorRuntime = (deps: {
  readonly services: Context.Context<SqlClient.SqlClient | Crypto.Crypto>
  readonly clock: ReferenceOf<typeof FrameworkClock>
  readonly outbox: ReferenceOf<typeof OutboxRuntime>
  readonly effectOf: (actorType: string, effect: string) => RegisteredEffect | undefined
  readonly wake: Effect.Effect<void>
}) => {
  const placement = (actorType: string) =>
    Effect.gen(function* () {
      return Option.fromUndefinedOr(yield* recordedPlacement(actorType))
    }).pipe(Effect.orDie, Effect.provideContext(deps.services))

  const keyOf = (target: ActorTarget) =>
    Effect.flatMap(placement(target.actorType), (found) =>
      Option.match(found, {
        onNone: () => Effect.fail(OperatorNotFound.make({})),
        onSome: (kind) =>
          Effect.succeed(
            routingKey({
              ref: { tenant: target.tenant, actor: target.actorType, id: target.actorId },
              placement: kind,
            }),
          ),
      }),
    )

  const provided = <A, E>(
    effect: Effect.Effect<A, E | SqlError.SqlError, SqlClient.SqlClient | Crypto.Crypto>,
  ) =>
    effect.pipe(
      Effect.catchIf(SqlError.isSqlError, Effect.die),
      Effect.provideService(FrameworkClock, deps.clock),
      Effect.provideService(OutboxRuntime, deps.outbox),
      Effect.provideContext(deps.services),
    )

  const transacted =
    (tenant: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(SqlClient.SqlClient, (sql) => withTenant(tenant)(sql.withTransaction(effect)))

  // Locks the dead letter the repair acts on, so two repairs of it serialize
  // and the second finds nothing.
  const lockLetter = (key: bigint, target: ActorTarget, effectId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const [letter] = yield* sql<DeadLetterRow>`
        SELECT effect, payload, payload_version AS "payloadVersion", attempts::int AS attempts, cause, ambiguous
        FROM actor_dead_letters
        WHERE routing_key = ${key} AND effect_id = ${effectId} AND tenant_id = ${target.tenant}
          AND actor_type = ${target.actorType} AND actor_id = ${target.actorId}
        FOR UPDATE`

      if (letter === undefined) return yield* OperatorNotFound.make({})

      yield* sql`DELETE FROM actor_dead_letters WHERE routing_key = ${key} AND effect_id = ${effectId}`

      return letter
    })

  return OperatorRuntime.of({
    placement,
    inspect: ({ limit, outcomes, ...target }) =>
      Queries.readOnly(target.tenant)(
        Queries.actor({
          tenant: target.tenant,
          actorType: target.actorType,
          actorId: target.actorId,
          limit,
        }),
      ).pipe(
        Effect.map(
          Option.map((page) =>
            outcomes
              ? page
              : {
                  ...page,
                  // Without receipts.read an operator sees that a command ran, not what it returned.
                  receipts: page.receipts.map(({ outcome: _outcome, ...receipt }) => receipt),
                },
          ),
        ),
        Effect.orDie,
        provided,
      ),
    receipt: ({ commandId, ...target }) =>
      Effect.gen(function* () {
        const key = yield* keyOf(target)
        const sql = yield* SqlClient.SqlClient

        const [row] = yield* readOnly(target.tenant)(sql<{
          command: string
          outcome_tag: string
          outcome: string
          expires_at_ms: number
        }>`SELECT command, outcome_tag, outcome, expires_at_ms::float8 AS expires_at_ms
          FROM durable.receipts
          WHERE routing_key = ${key} AND tenant_id = ${target.tenant}
            AND actor_type = ${target.actorType} AND actor_id = ${target.actorId}
            AND command_id = ${commandId}`)

        return Option.map(Option.fromUndefinedOr(row), (found) => ({
          commandId,
          command: found.command,
          outcomeTag: found.outcome_tag,
          outcome: decodeText(found.outcome),
          expiresAtMs: found.expires_at_ms,
        }))
      }).pipe(
        Effect.catchTag("OperatorNotFound", () => Effect.succeedNone),
        provided,
      ),
    retry: ({ target, effectId, providerChecked, audit }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const key = yield* keyOf(target)

        const ref = ActorRef.make({
          tenant: target.tenant,
          actor: target.actorType,
          id: target.actorId,
        })

        const retried = yield* transacted(target.tenant)(
          Effect.gen(function* () {
            const letter = yield* lockLetter(key, target, effectId)

            if (letter.ambiguous && !providerChecked)
              return yield* ProviderOutcomeUnknown.make({ effectId })

            const registered = deps.effectOf(target.actorType, letter.effect)

            if (registered === undefined)
              return yield* EffectNotServed.make({ effect: letter.effect })

            // The retry is the operator's act, so it carries no end user's principal.
            const staged = yield* outboxStatements(
              key,
              ref,
              {
                ...emptyOutbox,
                effects: [
                  {
                    effect: letter.effect,
                    payload: letter.payload,
                    version: letter.payloadVersion,
                    caller: System.make({ source: "actor", ref }),
                    due: undefined,
                    key: undefined,
                    capped: registered.perActor !== undefined,
                  },
                ],
              },
              databaseTime,
            )

            for (const statement of staged.statements) yield* statement

            const retriedId = staged.effectIds[0]!

            yield* writeAudit({
              entry: audit,
              key,
              outcome: {
                retried: effectId,
                effectId: retriedId,
                effect: letter.effect,
                attempts: letter.attempts,
                ambiguous: letter.ambiguous,
                providerChecked,
              },
            })

            return { effectId: retriedId }
          }),
        )

        yield* deps.wake

        return retried
      }).pipe(provided),
    discard: ({ target, effectId, audit }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const key = yield* keyOf(target)

        yield* transacted(target.tenant)(
          Effect.gen(function* () {
            const letter = yield* lockLetter(key, target, effectId)

            // The payload may hold customer data, so the record keeps what failed, not what was sent.
            yield* writeAudit({
              entry: audit,
              key,
              outcome: {
                discarded: effectId,
                effect: letter.effect,
                attempts: letter.attempts,
                ambiguous: letter.ambiguous,
                cause: letter.cause,
              },
            })
          }),
        )
      }).pipe(provided),
    audit: (page) => readOnly(page.tenant)(listAudit(page)).pipe(provided, Effect.orDie),
    record: (entry, outcome) =>
      Effect.gen(function* () {
        const found =
          entry.actorType === undefined ? Option.none() : yield* placement(entry.actorType)

        yield* writeAudit({
          entry,
          key: auditRoutingKey({ entry, placement: Option.getOrUndefined(found) }),
          outcome,
        })
      }).pipe(provided, Effect.orDie),
  })
}
