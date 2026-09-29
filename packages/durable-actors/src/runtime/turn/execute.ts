import { Crypto, Effect, Exit, Option, Result, Schema } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { ActorError, CommandExpired, NotCreated, Unauthorized } from "../../errors/actor.ts"
import {
  type Broadcast,
  type BusinessResult,
  type ConnectionLister,
  type EmittedEvent,
  Outcome,
  type RegisteredCommand,
  type Request,
} from "../../handles/actors.ts"
import { callerKey, System } from "../../identity/caller.ts"
import { commandTimes } from "../../identity/command.ts"
import { isMintedId, provesMint } from "../../identity/mint.ts"
import type { TurnPolicy } from "../../policies/command.ts"
import { type CronEntry, writeTicks } from "../cron/schedule.ts"
import { eventsStatement, notifyEvents } from "../events/append.ts"
import { COMMIT_VERSION } from "../database/replica.ts"
import { compress, decompress } from "../storage/codec.ts"
import { hashedPayload } from "../subscriptions/identity.ts"
import { receiptMarginMs } from "../storage/retention.ts"
import { databaseTime, FrameworkClock } from "./admission.ts"
import { RetryTurn, TurnHooks } from "./hooks.ts"
import { CallerJson, OutboxRuntime, type OutboxReplies, outboxStatements } from "./outbox.ts"
import {
  asSqlConnection,
  isInterrupted,
  pipeline,
  sequential,
  TurnConnections,
} from "./pipeline.ts"
import { checkReceipt, encodeOutcome, hashCanonical, type StoredReceipt } from "./receipt.ts"

const isSystem = Schema.is(System)

/**
 * What one activation remembers between turns. `generation` is the
 * fenced authority epoch it acquired; `state` is the committed state it last
 * read or wrote. The generation fence proves no other writer committed since,
 * so a cached activation skips the state read. Only a commit replaces either.
 */
export interface ActivationCache {
  generation: string | undefined
  state: ReadonlyMap<string, string> | undefined
}

/** A fresh activation has acquired no generation and read no state. */
export const emptyActivationCache = (): ActivationCache => ({
  generation: undefined,
  state: undefined,
})

/** The events a turn committed: sequences `after + 1` onward, stamped `emittedAtMs`. */
export interface CommittedEvents {
  readonly after: string
  readonly events: ReadonlyArray<EmittedEvent>
  readonly commandId: string
  readonly emittedAtMs: number
}

interface Admission {
  readonly now: string
  readonly generation: string
  readonly created: boolean
  readonly canonical: string
  readonly caller_key: string | null
  readonly command: string | null
  readonly payload_hash: string | null
  readonly outcome: string | null
  readonly head: string
  /** The subscriber's cursor row for a subscription delivery, read with the fence. */
  readonly sub_epoch?: string | null
  readonly sub_active?: boolean | null
  readonly sub_applied?: string | null
}

type Acknowledgement = (typeof Outcome.cases.Acknowledged.Type)["reason"]

/**
 * How the subscriber's cursor row settles a subscription delivery before its
 * handler runs: undefined runs the handler. A row of a newer epoch makes the
 * delivery stale, an inactive row at its epoch means it was unsubscribed, and
 * a position at or below `applied` was already applied. A dynamic
 * subscription always has a row, so only a routed one (epoch 0) creates it.
 */
const acknowledgement = (
  delivery: NonNullable<Request["delivery"]>,
  admission: Admission,
): Acknowledgement | undefined => {
  const epoch = BigInt(delivery.epoch)

  if (admission.sub_epoch == null) return epoch > 0n ? "Stale" : undefined

  const stored = BigInt(admission.sub_epoch)

  if (stored !== epoch) return "Stale"

  if (admission.sub_active !== true) return "Unsubscribed"

  if (delivery.kind === "rejected") return undefined

  return BigInt(admission.sub_applied!) >= BigInt(delivery.position) ? "AlreadyApplied" : undefined
}

/**
 * True when `request` is a minted actor's creating intent: its caller carries
 * the parent's mint proof for the actor's id, and the parent's committed
 * outbox still holds that exact intent with the same payload.
 */
const committedMintIntent = Effect.fnUntraced(function* (request: Request) {
  const { caller, ref } = request

  if (!isSystem(caller) || caller.ref === undefined || !(yield* provesMint(caller, ref)))
    return false

  const sql = yield* SqlClient.SqlClient

  const rows = yield* sql<{ caller: string }>`SELECT caller FROM actor_outbox
    WHERE intent_id = ${request.commandId} AND kind = 'intent' AND tenant_id = ${ref.tenant}
      AND actor_type = ${caller.ref.actor} AND actor_id = ${caller.ref.id}
      AND target_type = ${ref.actor} AND target_id = ${ref.id} AND command = ${request.command}
      AND payload::jsonb = ${request.payload}::jsonb`

  if (rows.length === 0) return false

  const committed = yield* Schema.decodeEffect(CallerJson)(rows[0]!.caller).pipe(Effect.orDie)

  return (
    isSystem(committed) &&
    committed.ref?.tenant === caller.ref.tenant &&
    committed.ref.actor === caller.ref.actor &&
    committed.ref.id === caller.ref.id &&
    committed.mint?.commandId === caller.mint?.commandId &&
    committed.mint?.ordinal === caller.mint?.ordinal
  )
})

type Statement = Effect.Effect<void, SqlError.SqlError>

/**
 * How a turn reaches its transaction. On Postgres the turn leases a session,
 * opens the transaction itself, and sends each group as one flight. PGlite has
 * one in-process session and nothing to pipeline, so its groups run one
 * statement at a time inside `withTransaction`.
 */
interface Session {
  readonly send: (group: ReadonlyArray<Statement>) => Statement
  readonly control: (text: string) => Statement
}

/** What a turn decided once its handler ran, or that it answers from a receipt. */
interface Plan {
  /** The commit group without `COMMIT`; undefined when the turn only rolls back. */
  readonly writes: ReadonlyArray<Statement> | undefined
  readonly outcome: Outcome
  readonly generation: string
  readonly state: ReadonlyMap<string, string> | undefined
  /** A workflow waits on an emitted class, so the relay should wake after commit. */
  readonly wake: boolean
  /** Broadcasts a committed success publishes to the actor's connections. */
  readonly broadcasts: ReadonlyArray<Broadcast>
  /** The actor's event sequence once this turn commits. */
  readonly head: string
  /** The events this turn commits, without their stamp. */
  readonly committed: Omit<CommittedEvents, "emittedAtMs">
  /** Filled in as the commit group replies, so read only after it has. */
  readonly outbox: OutboxReplies
  /** Filled in as the commit group replies: the stamp, and whether a subscription feed row is due. */
  readonly emitted: { readonly emittedAtMs: number; readonly fed: boolean }
}

class RolledBack {
  constructor(readonly plan: Plan) {}
}

const HANDLER_SAVEPOINT = "durable_handler"

/**
 * One command turn in one framework transaction, sent as two groups. The
 * admission group opens the transaction, takes the generation fence, resolves
 * the receipt, and on a cold activation acquires the next generation and reads
 * state. The handler runs in memory once those replies arrive. The commit group
 * writes dirty state, events, outbox rows, the creation marker, and the
 * receipt, then commits. A stale fence, a replayed receipt, or any failure
 * rolls back instead and writes nothing.
 *
 * `statements` marks an actor whose handler can issue SQL; only its handler
 * runs under a savepoint, so a declared failure discards the handler's rows.
 */
export const executeTurn = Effect.fnUntraced(function* (
  request: Request,
  command: RegisteredCommand,
  cache: ActivationCache,
  routingKey: bigint,
  policy: TurnPolicy,
  mintable: boolean,
  statements: boolean,
  waited: ReadonlySet<string> = new Set(),
  connections?: ConnectionLister,
  cron: ReadonlyArray<CronEntry> = [],
) {
  const sql = yield* SqlClient.SqlClient
  const hooks = yield* TurnHooks
  const clock = yield* FrameworkClock
  const { tenant, actor, id } = request.ref

  const actorRow = sql`routing_key = ${routingKey} AND tenant_id = ${tenant} AND actor_type = ${actor} AND actor_id = ${id}`

  const delivery = request.delivery

  const cursorRow =
    delivery === undefined
      ? undefined
      : sql`${actorRow} AND subscription = ${delivery.subscription}
          AND source_type = ${delivery.sourceType} AND source_id = ${delivery.sourceId}`

  // A delivery reads its cursor row in the fenced admission statement; other
  // turns keep the statement unchanged.
  const cursorColumns =
    delivery === undefined
      ? sql.literal("")
      : sql`, c.epoch::text AS sub_epoch, c.active AS sub_active, c.applied::text AS sub_applied`

  const cursorJoin =
    delivery === undefined
      ? sql.literal("")
      : sql`LEFT JOIN actor_subscription_cursors c ON c.routing_key = g.routing_key
          AND c.tenant_id = g.tenant_id AND c.actor_type = g.actor_type AND c.actor_id = g.actor_id
          AND c.subscription = ${delivery.subscription} AND c.source_type = ${delivery.sourceType}
          AND c.source_id = ${delivery.sourceId}`

  // A routed subscriber's row starts at epoch 0 with its first delivery.
  const applyCursor = (position: string) =>
    Effect.asVoid(sql`INSERT INTO actor_subscription_cursors (routing_key, tenant_id, actor_type, actor_id,
        subscription, source_type, source_id, epoch, active, applied)
      VALUES (${routingKey}, ${tenant}, ${actor}, ${id}, ${delivery!.subscription},
        ${delivery!.sourceType}, ${delivery!.sourceId}, 0, true, ${position})
      ON CONFLICT (routing_key, tenant_id, actor_type, actor_id, subscription, source_type, source_id)
      DO UPDATE SET applied = greatest(actor_subscription_cursors.applied, EXCLUDED.applied)
      WHERE actor_subscription_cursors.epoch = 0`)

  // A delivery's canonical payload binds its identity, not the event's bytes.
  const canonical = yield* hashedPayload(request)

  const turn = Effect.fnUntraced(function* (session: Session, begin: ReadonlyArray<Statement>) {
    const cold = cache.generation === undefined

    const timeouts = sql`set_config('lock_timeout', ${`${policy.lockWaitMs}ms`}, true),
      set_config('statement_timeout', ${`${policy.executionMs}ms`}, true)`

    const readsState = cold || cache.state === undefined
    let admission: Admission | undefined
    let bumped: string | undefined
    let stored: ReadonlyArray<{ key: string; value: Uint8Array }> = []

    // None of these takes a parameter from another's reply. The insert comes
    // before the fenced read, so a brand-new actor's receipt is resolved under
    // the generation row lock too.
    yield* session.send([
      ...begin,
      // set_config runs before the row is inserted, so lock_timeout bounds the
      // insert's row waits but not the table lock taken when the statement
      // starts; statement_timeout applies from the next statement.
      cold
        ? Effect.asVoid(sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
            SELECT ${routingKey}, ${tenant}, ${actor}, ${id}
            FROM (SELECT ${timeouts}) AS timeouts
            ON CONFLICT DO NOTHING`)
        : Effect.asVoid(sql`SELECT ${timeouts}`),
      Effect.map(
        sql<Admission>`
          SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now,
            g.generation::text AS generation, g.created,
            ${canonical}::jsonb::text AS canonical,
            r.caller_key, r.command, r.payload_hash, r.outcome, g.event_sequence::text AS head
            ${cursorColumns}
          FROM actor_generations g
          LEFT JOIN actor_receipts r ON r.routing_key = g.routing_key AND r.tenant_id = g.tenant_id
            AND r.actor_type = g.actor_type AND r.actor_id = g.actor_id AND r.command_id = ${request.commandId}
          ${cursorJoin}
          WHERE g.routing_key = ${routingKey} AND g.tenant_id = ${tenant}
            AND g.actor_type = ${actor} AND g.actor_id = ${id}
          FOR UPDATE OF g`,
        (rows) => {
          admission = rows[0]
        },
      ),
      ...(cold
        ? [
            Effect.map(
              sql<{ generation: string }>`
                UPDATE actor_generations SET generation = generation + 1 WHERE ${actorRow}
                RETURNING generation::text AS generation`,
              (rows) => {
                bumped = rows[0]?.generation
              },
            ),
          ]
        : []),
      ...(readsState
        ? [
            Effect.map(
              sql<{ key: string; value: Uint8Array }>`
                SELECT key, value FROM actor_state WHERE ${actorRow}`,
              (rows) => {
                stored = rows
              },
            ),
          ]
        : []),
      ...(statements ? [session.control(`SAVEPOINT ${HANDLER_SAVEPOINT}`)] : []),
    ])

    // Another runner advanced the generation since this activation acquired
    // it, so its cached state may be stale. Nothing runs or is written; the
    // activation drops its cache and the retry reloads under a new generation.
    if (admission === undefined || (!cold && cache.generation !== admission.generation)) {
      cache.generation = undefined
      cache.state = undefined

      return yield* Effect.die(RetryTurn.make({ message: "Stale actor generation" }))
    }

    const admitted = admission
    const current = cold ? bumped! : admitted.generation
    const hash = yield* hashCanonical(admitted.canonical)

    // The first turn a generation commits schedules every entry not yet
    // ticking, from the database clock after its handler ran, so a first tick
    // is never due before the turn that writes it.
    const ticks =
      cold && cron.length > 0
        ? Effect.gen(function* () {
            const now = yield* databaseTime
            const services = yield* Effect.context<SqlClient.SqlClient | Crypto.Crypto>()

            return [
              writeTicks(routingKey, request.ref, cron, now).pipe(Effect.provideContext(services)),
            ]
          })
        : Effect.succeed([])

    if (admitted.outcome !== null) {
      const outcome = yield* checkReceipt(request, hash, admitted as StoredReceipt)

      // A cold activation keeps the generation it acquired, so work the
      // replay wakes runs under it; a warm one has nothing to commit.
      return {
        writes: cold ? yield* ticks : undefined,
        outcome,
        generation: current,
        state: cold ? undefined : cache.state,
        wake: false,
        broadcasts: [],
        head: admitted.head,
        committed: { after: admitted.head, events: [], commandId: request.commandId },
        outbox: { wake: false, cancelled: false, cancelledIds: [] },
        emitted: { emittedAtMs: 0, fed: false },
      } satisfies Plan
    }

    const now = Number(admitted.now) + clock.offsetMillis()

    // Admitted work still runs past expiry, but not once cleanup may have
    // pruned a receipt of this id that committed meanwhile: without it, an
    // expired external id would run again.
    if (
      request.external === true &&
      now >=
        commandTimes(request.commandId).expiresAt +
          receiptMarginMs({
            keepReceiptsMs: policy.keepReceiptsMs,
            deliveryMs: policy.deliveryMs,
            retryWindowMs: (yield* OutboxRuntime).retryWindowMs,
          })
    )
      return yield* ActorError.make({
        reason: CommandExpired.make({ commandId: request.commandId }),
      })

    if (command.internal && !isSystem(request.caller))
      return yield* Effect.die(new Error("Internal commands require a System caller"))

    // Acknowledged without running the handler; a cold activation keeps the
    // generation it acquired, as a replay does.
    const acknowledged = (reason: Acknowledgement, writes: ReadonlyArray<Statement> = []) =>
      ({
        writes: cold || writes.length > 0 ? writes : undefined,
        outcome: Outcome.cases.Acknowledged.make({ reason }),
        generation: current,
        state: cold ? undefined : cache.state,
        wake: false,
        broadcasts: [],
        head: admitted.head,
        committed: { after: admitted.head, events: [], commandId: request.commandId },
        outbox: { wake: false, cancelled: false, cancelledIds: [] },
        emitted: { emittedAtMs: 0, fed: false },
      }) satisfies Plan

    // Only the relay's subscription deliveries reach a handler, and only a
    // handler takes one, so no caller can reach it around the cursor or route.
    if (command.handler || delivery !== undefined) {
      const caller = request.caller

      if (
        !command.handler ||
        delivery === undefined ||
        !isSystem(caller) ||
        caller.source !== "subscription" ||
        caller.ref?.actor !== delivery.sourceType ||
        caller.ref.id !== delivery.sourceId
      )
        return yield* Effect.die(
          new Error("Subscription handlers accept only subscription deliveries"),
        )

      if (caller.ref.tenant !== tenant)
        return yield* Effect.die(new Error("A subscription delivery crosses tenants"))

      const reason = acknowledgement(delivery, admitted)

      if (reason !== undefined) return acknowledged(reason)
    }

    if (
      policy.createdBy !== undefined &&
      !admitted.created &&
      policy.createdBy !== request.command
    ) {
      // A routed event for a subscriber its creating command hasn't created
      // is skipped, and the cursor keeps a stale redelivery of it from
      // running after another command creates the subscriber.
      if (delivery !== undefined && delivery.epoch === "0" && delivery.kind === "event")
        return acknowledged("NotCreated", [applyCursor(delivery.position)])

      return yield* ActorError.make({ reason: NotCreated.make({}) })
    }

    // A minted actor is created only by the relay delivering the creating
    // intent its parent's turn staged and committed: the proof binds the id to
    // the parent's command, and the parent's outbox row, which stays until its
    // delivery commits, proves that command committed the intent.
    if (
      mintable &&
      policy.createdBy === request.command &&
      !admitted.created &&
      isMintedId(id) &&
      (request.external === true || !(yield* committedMintIntent(request)))
    )
      return yield* ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) })

    const committed = readsState
      ? new Map(stored.map(({ key, value }) => [key, decompress(value)] as const))
      : cache.state!

    const business = yield* Effect.gen(function* () {
      yield* hooks.at("beforeHandler", request)

      return yield* command.run(request, [...committed], { head: admitted.head, connections })
    }).pipe(Effect.catchIf(SqlError.isSqlError, Effect.die), Effect.result)

    const result: BusinessResult = Result.isSuccess(business) ? business.success : business.failure
    const next = new Map(committed)
    const dirty = new Map(result.state)
    const writes: Array<Statement> = []

    if (statements)
      writes.push(
        session.control(
          Result.isSuccess(business)
            ? `RELEASE SAVEPOINT ${HANDLER_SAVEPOINT}`
            : `ROLLBACK TO SAVEPOINT ${HANDLER_SAVEPOINT}`,
        ),
      )

    for (const [key, value] of dirty) next.set(key, value)

    if (dirty.size > 0)
      writes.push(
        Effect.asVoid(sql`INSERT INTO actor_state ${sql.insert(
          [...dirty].map(([key, value]) => ({
            routing_key: routingKey,
            tenant_id: tenant,
            actor_type: actor,
            actor_id: id,
            key,
            value: compress(value),
          })),
        )}
        ON CONFLICT (routing_key, tenant_id, actor_type, actor_id, key) DO UPDATE SET value = EXCLUDED.value`),
      )

    if (result.complete) {
      const removed = [...committed.keys()].filter((key) => !dirty.has(key))

      for (const key of removed) next.delete(key)

      if (removed.length > 0)
        writes.push(
          Effect.asVoid(
            sql`DELETE FROM actor_state WHERE ${actorRow} AND key IN ${sql.in(removed)}`,
          ),
        )
    }

    const events =
      result.events.length > 0
        ? yield* eventsStatement(request, routingKey, result.events)
        : { statement: undefined, stamp: { emittedAtMs: 0, fed: false } }

    if (events.statement !== undefined) writes.push(events.statement)

    // Re-arming waiting workflows reads their steps, so it runs before the
    // commit group; only an actor with a workflow waiting on an emitted class
    // pays for it.
    const notified = yield* notifyEvents(request, routingKey, result.events, waited)

    const creates =
      Outcome.guards.Success(result.outcome) &&
      policy.createdBy === request.command &&
      !admitted.created

    if (creates)
      writes.push(Effect.asVoid(sql`UPDATE actor_generations SET created = true WHERE ${actorRow}`))

    const outbox = yield* outboxStatements(
      routingKey,
      request.ref,
      result.outbox,
      Effect.succeed(now),
      { slackMs: policy.executionMs },
    )

    writes.push(...outbox.statements, ...(yield* ticks))

    // The delivery's position is applied with its receipt, declared failures included.
    if (delivery !== undefined)
      writes.push(
        delivery.kind === "rejected"
          ? Effect.asVoid(sql`UPDATE actor_subscription_cursors SET active = false
              WHERE ${cursorRow!} AND epoch = ${delivery.epoch}`)
          : delivery.epoch === "0"
            ? applyCursor(delivery.position)
            : Effect.asVoid(sql`UPDATE actor_subscription_cursors SET applied = ${delivery.position}
                WHERE ${cursorRow!} AND epoch = ${delivery.epoch}`),
      )

    const encoded = yield* encodeOutcome(result.outcome).pipe(Effect.orDie)
    writes.push(
      Effect.asVoid(sql`INSERT INTO actor_receipts (routing_key, tenant_id, actor_type, actor_id, command_id, command, payload_hash, caller_key, outcome, expires_at_ms)
        VALUES (${routingKey}, ${tenant}, ${actor}, ${id}, ${request.commandId}, ${request.command}, ${hash}, ${callerKey(request.caller)}, ${encoded}, ${commandTimes(request.commandId).expiresAt})`),
    )
    yield* hooks.at("beforeCommit", request)

    return {
      writes,
      outcome: result.outcome,
      generation: current,
      state: next,
      wake: notified,
      broadcasts: Outcome.guards.Success(result.outcome) ? (result.broadcasts ?? []) : [],
      head: String(BigInt(admitted.head) + BigInt(result.events.length)),
      committed: { after: admitted.head, events: result.events, commandId: request.commandId },
      outbox: outbox.replies,
      emitted: events.stamp,
    } satisfies Plan
  })

  const turns = yield* Effect.serviceOption(TurnConnections)

  const transaction = Option.isSome(turns)
    ? pipelined(turns.value, turn)
    : sql
        .withTransaction(
          Effect.gen(function* () {
            const plan = yield* turn(
              { send: sequential, control: (text) => Effect.asVoid(sql.unsafe(text)) },
              [],
            )

            if (plan.writes === undefined) return yield* Effect.fail(new RolledBack(plan))
            yield* sequential(plan.writes)

            return plan
          }),
        )
        .pipe(
          Effect.catchIf(
            (error) => error instanceof RolledBack,
            (rolled) => Effect.succeed(rolled.plan),
          ),
          Effect.flatMap((plan) =>
            Effect.map(sql.unsafe<{ version: string }>(COMMIT_VERSION), (rows) => ({
              ...plan,
              version: rows[0]!.version,
            })),
          ),
        )

  const done = yield* transaction.pipe(
    Effect.interruptible,
    Effect.timeoutOrElse({
      duration: policy.executionMs,
      orElse: () => Effect.die(RetryTurn.make({ message: "Command execution timeout" })),
    }),
    Effect.catchIf(SqlError.isSqlError, Effect.die),
    // A failed or unknown commit leaves nothing the cache can trust.
    Effect.onError(() =>
      Effect.sync(() => {
        cache.state = undefined
      }),
    ),
  )

  cache.generation = done.generation
  cache.state = done.state

  if (done.wake || done.outbox.wake || done.emitted.fed) yield* (yield* OutboxRuntime).wake

  if (done.outbox.cancelled) yield* (yield* OutboxRuntime).cancelled

  return {
    outcome: done.outcome,
    broadcasts: done.broadcasts,
    head: done.head,
    committed: {
      ...done.committed,
      emittedAtMs: done.emitted.emittedAtMs,
    } satisfies CommittedEvents,
    /** Started effects this turn cancelled. */
    cancelledEffects: done.outbox.cancelledIds,
    /** The commit version a caller's later queries wait for. */
    version: done.version,
  }
})

/**
 * Runs a turn on a leased Postgres session: the admission group opens with
 * `BEGIN`, and the commit group ends with `COMMIT`, whose command tag must be
 * `COMMIT`, since Postgres answers `COMMIT` in an aborted transaction with
 * `ROLLBACK`. Any other exit rolls back, and a session whose transaction state
 * is unknown never goes back to the pool: an interrupted turn cancels its
 * backend's statement and discards the session, so an unsent `COMMIT` rolls
 * back with it and one already sent resolves through the receipt on retry.
 */
const pipelined = <E, R>(
  turns: TurnConnections["Service"],
  turn: (session: Session, begin: ReadonlyArray<Statement>) => Effect.Effect<Plan, E, R>,
): Effect.Effect<
  Plan & { readonly version: string },
  E | SqlError.SqlError,
  R | SqlClient.SqlClient
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const connection = yield* turns.lease
      let open = false

      const control = (text: string) => connection.query(text, [], true)

      const end = (text: "COMMIT" | "ROLLBACK") =>
        Effect.map(control(text), (result) => {
          open = false

          return result.command
        })

      let tag: string | undefined

      const plan = yield* Effect.gen(function* () {
        // The session is unsafe from the moment BEGIN may be queued until a
        // transaction-ending reply confirms it is idle again.
        open = true
        const begin = Effect.asVoid(control("BEGIN"))

        const decided = yield* turn(
          { send: pipeline, control: (text) => Effect.asVoid(control(text)) },
          [begin],
        )

        const ending = decided.writes === undefined ? "ROLLBACK" : "COMMIT"

        let version = ""

        // The version is read on this session after the transaction ends, in
        // the same flight, so it covers the turn's commit record and any
        // receipt the turn replayed.
        yield* pipeline([
          ...(decided.writes ?? []),
          Effect.map(end(ending), (command) => {
            tag = command
          }),
          Effect.map(connection.query(COMMIT_VERSION, [], true), (result) => {
            version = (result.rows[0] as { version: string }).version
          }),
        ])

        if (ending === "COMMIT" && tag !== "COMMIT")
          return yield* Effect.die(RetryTurn.make({ message: "Turn commit rolled back" }))

        return { ...decided, version }
      }).pipe(
        Effect.provideService(sql.transactionService, [asSqlConnection(connection), 0]),
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit) || !open) return Effect.void

          if (isInterrupted(exit))
            return sql`SELECT pg_cancel_backend(${connection.processId})`.pipe(
              Effect.ignore,
              Effect.andThen(turns.invalidate(connection)),
            )

          return end("ROLLBACK").pipe(
            Effect.catch(() => turns.invalidate(connection)),
            Effect.asVoid,
          )
        }),
      )

      return plan
    }),
  )
