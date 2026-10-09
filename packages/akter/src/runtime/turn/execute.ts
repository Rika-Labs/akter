import {
  Cause,
  Clock,
  Context,
  Crypto,
  Effect,
  Exit,
  Option,
  Predicate,
  Result,
  Schema,
  Scope,
} from "effect"
import type { PgConnection } from "@effect/sql-pg"
import { SqlClient, SqlError } from "effect/sql"
import { ActorError, CommandExpired, NotCreated, Unauthorized } from "../../errors/actor.ts"
import {
  type Broadcast,
  type BusinessResult,
  type ConnectionLister,
  type EmittedEvent,
  type RegisteredCommand,
} from "../members.ts"
import { Outcome, type Request } from "../request.ts"
import { callerKey, System } from "../../identity/caller.ts"
import { commandTimes } from "../../identity/command.ts"
import { isMintedId, provesMint } from "../../identity/mint.ts"
import { parseChildId } from "../../identity/child.ts"
import type { TurnPolicy } from "../../policies/command.ts"
import { type CronEntry, writeTicks } from "../cron/schedule.ts"
import type { WriteSet } from "../connections/protocol.ts"
import { eventsStatement, notifyEvents } from "../events/append.ts"
import { COMMIT_VERSION } from "../database/replica.ts"
import { isPoolRefusal } from "../database/bounded.ts"
import { compress, decompress } from "../storage/codec.ts"
import { Metrics, record } from "../telemetry/metrics.ts"
import { SpanNames } from "../telemetry/spans.ts"
import { receiptMarginMs } from "../storage/retention.ts"
import type { UsageAccountingService } from "../telemetry/usage.ts"
import { hashedPayload } from "../subscriptions/identity.ts"
import { tenantSettings, TenantScope } from "../database/tenancy.ts"
import { type ActivationCache, actorRow as rowOf, forget } from "../storage/generation.ts"
import { checkIdentity, databaseTime, FrameworkClock } from "./admission.ts"
import { abortedBefore, errorOf, type Member, Shared, TurnGroups, Unseated } from "./group.ts"
import { RetryTurn, TurnHooks } from "./hooks.ts"
import { OutboxRuntime, type OutboxReplies, outboxStatements } from "./outbox.ts"
import {
  asSqlConnection,
  awaitReplies,
  queueStatements,
  sendPipelined,
  sendSequentially,
  type Send,
  TurnConnections,
} from "./pipeline.ts"
import { MERGE_CAP, merges } from "../entity/mailbox.ts"
import { checkReceipt, encodeOutcome, hashCanonical, type StoredReceipt } from "./receipt.ts"

const isSystem = Schema.is(System)

/** Tests can exercise the ordinary admission pipeline independently of warm speculation. */
export const WarmTurnFastPath = Context.Reference<boolean>("akter/WarmTurnFastPath", {
  defaultValue: () => true,
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

type SubscriptionDelivery = NonNullable<Request["delivery"]>

/** A subscriber's cursor row as the fenced admission read it; all null when there is none. */
type Cursor = Pick<Admission, "sub_epoch" | "sub_active" | "sub_applied">

/**
 * The cursor row once `delivery` applied, as its commit writes it: a routed
 * delivery creates the epoch-0 row or raises its position, a dynamic one moves
 * the row of its own epoch, and a rejection deactivates that row.
 */
const applied = (delivery: SubscriptionDelivery, cursor: Cursor): Cursor => {
  const epoch = cursor.sub_epoch ?? null

  if (delivery.kind === "rejected")
    return epoch === delivery.epoch ? { ...cursor, sub_active: false } : cursor

  if (delivery.epoch === "0") {
    if (epoch === null) return { sub_epoch: "0", sub_active: true, sub_applied: delivery.position }

    if (epoch !== "0") return cursor

    const position =
      BigInt(cursor.sub_applied!) >= BigInt(delivery.position)
        ? cursor.sub_applied!
        : delivery.position

    return { ...cursor, sub_applied: position }
  }

  return epoch === delivery.epoch ? { ...cursor, sub_applied: delivery.position } : cursor
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
  delivery: SubscriptionDelivery,
  admission: Cursor,
): Acknowledgement | undefined => {
  const epoch = BigInt(delivery.epoch)

  if (admission.sub_epoch == null) return epoch > 0n ? "Stale" : undefined

  const stored = BigInt(admission.sub_epoch)

  if (stored !== epoch) return "Stale"

  if (admission.sub_active !== true) return "Unsubscribed"

  if (delivery.kind === "rejected") return undefined

  return BigInt(admission.sub_applied!) >= BigInt(delivery.position) ? "AlreadyApplied" : undefined
}

/** The first cron ticks a newly created actor stages, read against the database clock. */
const cronTicks = Effect.fnUntraced(function* (
  routingKey: bigint,
  ref: Request["ref"],
  cron: ReadonlyArray<CronEntry>,
) {
  const now = yield* databaseTime
  const services = yield* Effect.context<SqlClient.SqlClient | Crypto.Crypto>()

  return [writeTicks(routingKey, ref, cron, now).pipe(Effect.provideContext(services))]
})

/**
 * True when `request` is a minted actor's creating intent: its caller carries
 * the parent's mint proof for the actor's id, and its delivery carries the
 * sender of the committed outbox row the relay claimed. The trusted relay
 * copies the request from that row, and external admission refuses this
 * provenance. The child's transaction needs no read on the parent's shard.
 */
const committedMintIntent = Effect.fnUntraced(function* (
  request: Request,
  parent: string | undefined,
) {
  const { caller, ref, intent } = request

  if (
    request.external === true ||
    intent === undefined ||
    !isSystem(caller) ||
    caller.ref === undefined ||
    intent.tenant !== ref.tenant ||
    intent.tenant !== caller.ref.tenant ||
    intent.actor !== caller.ref.actor ||
    intent.id !== caller.ref.id
  )
    return false

  return yield* provesMint(caller, ref, parent)
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
  /**
   * Queues a control statement to go out ahead of the next statement on the
   * session, or with the commit group, so it adds no round trip of its own.
   */
  readonly defer: (text: string) => Statement
  /** Takes back the last deferred statement if it is `text` and still unsent. */
  readonly withdraw: (text: string) => boolean
}

/** One command waiting in an activation's mailbox, with the handler it runs. */
export interface Delivery {
  readonly request: Request
  readonly command: RegisteredCommand
  /** Set only after this external id passes the fenced admission check. */
  admitted?: boolean
}

/**
 * How one command of a batch ended: an outcome its receipt records or
 * replays, or an admission error answered without a receipt.
 */
export type Settled = Result.Result<Outcome, ActorError>

/** What a batch decided once its handlers ran. */
interface Plan {
  /** The commit group without `COMMIT`; undefined when the batch only rolls back. */
  readonly writes: ReadonlyArray<Statement> | undefined
  readonly settled: ReadonlyArray<Settled>
  readonly generation: string
  readonly state: ReadonlyMap<string, string> | undefined
  readonly created: boolean
  /** New outbox identities need an authoritative admission clock before they are staged. */
  readonly needsAdmissionClock: boolean
  /** A workflow waits on an emitted class, so the relay should wake after commit. */
  readonly wake: boolean
  /** Broadcasts the batch's committed successes publish to the actor's connections. */
  readonly broadcasts: ReadonlyArray<Broadcast>
  /** The actor's event sequence once this batch commits. */
  readonly head: string
  /** The database clock the batch's fenced admission read selected, before any test-clock offset. */
  readonly startedAtMs: number
  /**
   * Each command's committed events, in delivery order. Their stamps and the
   * outbox replies are filled in as the commit group replies, so read them
   * only after it has.
   */
  readonly committed: ReadonlyArray<Omit<CommittedEvents, "emittedAtMs">>
  /** Each events statement's stamp, and whether a subscription feed row is due. */
  readonly emitted: ReadonlyArray<{ readonly emittedAtMs: number; readonly fed: boolean }>
  readonly outbox: ReadonlyArray<OutboxReplies>
  /** The positions in `settled` that answered from a stored receipt without running a handler. */
  readonly replays: ReadonlySet<number>
  /** What the commit group writes, for the runner's growth metrics. */
  readonly written: Written
  /** What the commit changes that a watched query may have read. */
  readonly wrote: WriteSet
}

/** One `actor_receipts` row a batch commits. */
type ReceiptRow = {
  readonly routing_key: bigint
  readonly tenant_id: string
  readonly actor_type: string
  readonly actor_id: string
  readonly command_id: string
  readonly command: string
  readonly payload_hash: string
  readonly caller_key: string
  readonly outcome: string
  readonly expires_at_ms: number
  readonly started_at_ms: number
}

/** Rows a committed turn adds; nothing when it replays, acknowledges, or rolls back. */
export interface Written {
  readonly receipts: number
  readonly events: number
  readonly intents: number
  readonly jobs: number
}

const nothingWritten: Written = { receipts: 0, events: 0, intents: 0, jobs: 0 }

const nothingWrote: WriteSet = { state: false, events: [], tables: [], blobs: [] }

/** The activation as a batch's handlers find it: its fenced generation and state. */
interface View {
  readonly generation: string | undefined
  readonly state: ReadonlyMap<string, string> | undefined
}

/** What a committed or rolled-back batch answers. */
export interface Done {
  readonly settled: ReadonlyArray<Settled>
  /** Broadcasts the batch's committed successes publish to the actor's connections. */
  readonly broadcasts: ReadonlyArray<Broadcast>
  /** The actor's event sequence once the batch commits. */
  readonly head: string
  /** Each command's committed events, stamped, in delivery order. */
  readonly committed: ReadonlyArray<CommittedEvents>
  /** Started jobs the batch's commands cancelled. */
  readonly cancelledJobs: ReadonlyArray<string>
  readonly generation: string
  /** The positions in `settled` that answered from a stored receipt. */
  readonly replays: ReadonlySet<number>
  /** Rows the batch committed; none when it rolled back. */
  readonly written: Written
  /** The commit version each caller's later queries wait for. */
  readonly version: string
  /** The database clock read on the turn's session after the transaction ended. */
  readonly endedAtMs: number
  /** The database clock the batch's fenced admission read selected; 0 when the batch was never admitted. */
  readonly startedAtMs: number
  /** What the batch changed that a watched query may have read; nothing when it rolled back. */
  readonly wrote: WriteSet
  /** The commit made outbox or subscription work due now, so the relay should claim it at once. */
  readonly wake: boolean
  /** The commit cancelled a job attempt that is running, so running attempts should look now. */
  readonly cancelled: boolean
}

/**
 * How `transact` ended one batch's transaction: the batch's plan and commit
 * version, the batch it took from the mailbox while committing, and that
 * batch's admission when it was already sent behind this batch's `COMMIT`.
 */
interface Ended<W extends Delivery, P> {
  readonly plan: Plan
  readonly version: string
  readonly endedAtMs: number
  readonly certified?: boolean
  readonly following?: ReadonlyArray<W> | undefined
  readonly chained?: P | undefined
}

/**
 * Consecutive batches of one activation. `next` takes the batch already
 * waiting, if any, without waiting for one; `prepare` runs before each
 * batch's handlers, and `committed` once the batch commits or rolls back,
 * before the next batch's handlers run. `publishesUnderLock` names a batch
 * whose `committed` may wait for the generation row lock in a transaction of
 * its own; the next batch's admission would hold that lock until `committed`
 * returns, so it is sent only after.
 */
interface Run<W extends Delivery, RN, RP, RC> {
  readonly first: ReadonlyArray<W>
  readonly next: Effect.Effect<ReadonlyArray<W> | undefined, never, RN>
  readonly prepare: Effect.Effect<void, never, RP>
  readonly committed: (batch: ReadonlyArray<W>, done: Done) => Effect.Effect<void, never, RC>
  readonly publishesUnderLock: (batch: ReadonlyArray<W>) => boolean
  /** Wraps one batch's handlers, commit, and answers in that batch's own span and logs. */
  readonly observe: (
    batch: ReadonlyArray<W>,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/**
 * Why a run stopped early: the batch that failed, a following batch whose
 * admission was already sent and is rolled back unseen with it, and the cause.
 * Batches before them committed and were answered. `committed` says the batch
 * itself ended, committed or cleanly rolled back, and failed while its callers
 * were being answered, so its commands must resolve through their receipts.
 */
export interface Stopped<W extends Delivery> {
  readonly batch: ReadonlyArray<W>
  readonly orphan: ReadonlyArray<W> | undefined
  readonly cause: Cause.Cause<unknown>
  readonly committed: boolean
  /** The turn never leased a session, so no fence statement or handler was run. */
  readonly poolRefused?: boolean
}

class RolledBack {
  readonly plan: Plan

  constructor(plan: Plan) {
    this.plan = plan
  }
}

const HANDLER_SAVEPOINT = "durable_handler"

/**
 * Commands already waiting for one actor, run in delivery order in one
 * framework transaction sent as two groups. The admission group opens the
 * transaction, takes the generation fence, resolves every command's receipt
 * under it, and on a cold activation acquires the next generation and reads
 * state. The handlers run in memory once those replies arrive, each on the
 * state the previous one left. The commit group writes the dirty state, each
 * command's events and outbox rows, the creation marker, and every receipt,
 * then commits. A lone command is a batch of one.
 *
 * Each command keeps its own outcome: a declared failure discards only its
 * own staged work, and an admission error (expiry, `NotCreated`, a receipt
 * conflict) answers only that command. A stale fence or any defect fails the
 * whole batch and writes nothing. A batch with nothing to commit rolls back.
 * Every command id in a batch must be distinct.
 *
 * `statements` marks an actor whose handler can issue SQL; only its handlers
 * run under a savepoint, so a declared failure discards the handler's rows.
 * The first handler's savepoint goes out with admission and each later one's
 * with that handler's first statement. A handler that issued no statement has
 * nothing to roll back, so its unsent savepoint is dropped. Rolling back to a
 * savepoint keeps it, so each failed handler leaves one open until commit; a
 * batch never holds more savepoints than its command cap. `parent` is a
 * parent-placed actor's parent type, whose turns alone mint it, and `waited`
 * holds the event tags workflows wait on.
 *
 * Admission statements take no parameter from another's reply, so they share
 * one flight. The generation insert precedes the fenced read, so a brand-new
 * actor's receipts resolve under the generation row lock. The timeout
 * `set_config` runs before that insert, so `lock_timeout` bounds the insert's
 * row waits but not the table lock taken as the statement starts;
 * `statement_timeout` applies from the next statement. With row-level
 * security the same statement takes the tenant role, which binds every later
 * statement of the turn, the handler's included, to the actor's tenant at no
 * extra round trip. A subscription delivery's cursor row is read in the
 * fenced statement, and the delivery's canonical payload, not the event's
 * bytes, binds its identity. When another runner advanced the generation
 * since this activation acquired it, its cached state may be stale, so
 * nothing runs, the activation drops its cache, and the retry reloads under a
 * new generation.
 *
 * Admission checks. The generation row is locked in a materialized input
 * before the read evaluates its clock, so time spent waiting for the fence
 * cannot admit an identity that expired meanwhile. External ids are validated
 * against the fenced read's clock before their receipt is released or a handler
 * runs. An owner reports
 * that admission on a retryable failure, so only a previously admitted
 * redelivery can run past expiry, and not once retention could have pruned
 * its receipt. No pre-delivery receipt read is needed. Only the relay's subscription
 * deliveries reach a handler, and only a handler takes one, so no caller
 * reaches it around the cursor or route. A routed event for a subscriber its
 * creating command has not created is skipped, and its cursor keeps a stale
 * redelivery from running after another command creates the subscriber. A
 * minted actor is created only by the relay delivering the creating intent
 * its parent's turn staged and committed: the mint proof binds the id to the
 * parent's command, and the relay's claimed-row provenance proves that
 * command committed the intent without reading another actor's shard.
 *
 * Handlers and commit. Calls of a commutative reducer already waiting right
 * behind a command merge into its turn: their inputs are combined and reduced
 * once. A complete result lists every key it keeps, and any other key it was
 * given is deleted. A delivery's cursor position is applied with its receipt,
 * declared failures included. Re-arming waiting workflows reads their steps,
 * so it runs before the commit group and only an actor with a workflow
 * waiting on an emitted class pays for it. A cold activation that replays or
 * acknowledges still commits and keeps the generation it acquired, so work
 * the replay wakes runs under it. The first batch a generation commits
 * schedules every cron entry not yet ticking from the database clock after
 * its handlers ran, so a first tick is never due before the batch that
 * writes it. A batch's work is bounded like a lone turn's: interruption and
 * the command timeout roll it back, and SQL failures are defects. A failed or
 * unknown commit leaves nothing the cached state can be trusted for, so it
 * clears the cache.
 *
 * On Postgres a run uses one leased session. Each admission group opens with
 * `BEGIN`, and each commit group ends with `COMMIT`, whose command tag must
 * be `COMMIT`, since Postgres answers `COMMIT` in an aborted transaction with
 * `ROLLBACK`. While batch N commits, the next batch already waiting sends its
 * `BEGIN` and admission group in the same flight, right behind N's `COMMIT`:
 * the server runs them strictly after it, as a new transaction on the same
 * session. That admission is built as if N commits, which its fence proves. A
 * batch that leaves the cache cold is committed alone, so the next one
 * prepares, which may acquire the generation itself, before its admission
 * locks the generation row. So is a batch whose publication may wait for that
 * lock in another transaction: an admission already behind its `COMMIT` would
 * hold the lock until the publication it waits on ends, and neither would
 * ever finish. N's callers are answered once its `COMMIT` reply
 * arrives, and the next batch's handlers run only once its own fence and
 * receipt replies arrive. If N's commit fails, the next batch's transaction
 * is rolled back unseen with it. The commit version is read on the same
 * session after the transaction ends, in the same flight, so it covers the
 * batch's commit record and any receipt it replayed. The same statement reads
 * a fresh clock after the transaction ended for the external expiry recheck,
 * never reusing admission time.
 *
 * The session is unsafe from the moment a `BEGIN` may be queued until a
 * transaction-ending reply with nothing queued behind it. Any other exit
 * rolls back, and a session whose transaction state is unknown never goes
 * back to the pool: an interrupted batch cancels its backend's statement and
 * discards the session, so an unsent `COMMIT` rolls back with it and one
 * already sent resolves through the receipt on retry. Deferred statements go
 * out in the same flight as the next statement a handler sends, or at the
 * head of the commit group.
 */
export const executeBatches = Effect.fnUntraced(function* <W extends Delivery, RN, RP, RC>(
  run: Run<W, RN, RP, RC>,
  cache: ActivationCache,
  routingKey: bigint,
  policy: TurnPolicy,
  mintable: boolean,
  parent: string | undefined,
  statements: boolean,
  waited: ReadonlySet<string> = new Set(),
  connections?: ConnectionLister,
  cron: ReadonlyArray<CronEntry> = [],
  accounting?: UsageAccountingService,
) {
  const sql = yield* SqlClient.SqlClient
  const hooks = yield* TurnHooks
  const clock = yield* FrameworkClock
  const scope = yield* TenantScope
  const warmTurns = yield* WarmTurnFastPath
  const { ref } = run.first[0]!.request
  const { tenant, actor, id } = ref

  const role =
    scope.role ?? (scope.adoption?.enforced.has(actor) === true ? scope.adoption.role : undefined)

  const actorRow = rowOf({ sql, actor: { key: routingKey, ref } })

  const canonicalsOf = (batch: ReadonlyArray<Delivery>) =>
    Effect.forEach(batch, ({ request }) => hashedPayload(request))

  const cursorOf = (delivery: SubscriptionDelivery) =>
    sql`${actorRow} AND subscription = ${delivery.subscription}
      AND source_type = ${delivery.sourceType} AND source_id = ${delivery.sourceId}`

  const applyCursor = (delivery: SubscriptionDelivery) =>
    Effect.asVoid(sql`INSERT INTO actor_subscription_cursors (routing_key, tenant_id, actor_type, actor_id,
        subscription, source_type, source_id, epoch, active, applied)
      VALUES (${routingKey}, ${tenant}, ${actor}, ${id}, ${delivery.subscription},
        ${delivery.sourceType}, ${delivery.sourceId}, 0, true, ${delivery.position})
      ON CONFLICT (routing_key, tenant_id, actor_type, actor_id, subscription, source_type, source_id)
      DO UPDATE SET applied = greatest(actor_subscription_cursors.applied, EXCLUDED.applied)
      WHERE actor_subscription_cursors.epoch = 0`)

  const timeouts = sql`set_config('lock_timeout', ${`${policy.lockWaitMs}ms`}, true),
      set_config('statement_timeout', ${`${policy.executionMs}ms`}, true),
      set_config('durable.turn', 'on', true)
      ${role === undefined ? sql.literal("") : sql`, ${tenantSettings({ sql, role, tenant })}`}`

  /**
   * Turns that set the same transaction settings, which a group sets once for
   * all of them. Each part is encoded so no two settings share a key.
   */
  const groupKey = [
    policy.lockWaitMs,
    policy.executionMs,
    role === undefined ? "-" : `+${encodeURIComponent(role)}`,
    role === undefined ? "-" : `+${encodeURIComponent(tenant)}`,
  ].join(":")

  const admit = (
    batch: ReadonlyArray<Delivery>,
    canonicals: ReadonlyArray<string>,
    view: View,
    session: Session,
    begin: ReadonlyArray<Statement>,
    grouped = false,
    optimistic?: Admission,
  ) => {
    const cold = view.generation === undefined

    const readsState = cold || view.state === undefined
    let admissions: ReadonlyArray<Admission> = optimistic === undefined ? [] : [optimistic]
    let bumped: string | undefined
    let stored: ReadonlyArray<{ key: string; value: Uint8Array }> = []

    const subscribed = batch.some(({ request }) => request.delivery !== undefined)

    const commands = sql.csv(
      batch.map(({ request: { commandId, delivery } }, index) =>
        subscribed
          ? sql`(${index}::integer, ${commandId}::text, ${canonicals[index]!}::text,
              ${delivery?.subscription ?? null}::text, ${delivery?.sourceType ?? null}::text,
              ${delivery?.sourceId ?? null}::text)`
          : sql`(${index}::integer, ${commandId}::text, ${canonicals[index]!}::text)`,
      ),
    )

    const cursorColumns = subscribed
      ? sql`, s.epoch::text AS sub_epoch, s.active AS sub_active, s.applied::text AS sub_applied`
      : sql.literal("")

    const values = subscribed
      ? sql`(VALUES ${commands}) AS c (ordinal, command_id, payload, subscription, source_type, source_id)`
      : sql`(VALUES ${commands}) AS c (ordinal, command_id, payload)`

    const cursorJoin = subscribed
      ? sql`LEFT JOIN actor_subscription_cursors s ON s.routing_key = g.routing_key
          AND s.tenant_id = g.tenant_id AND s.actor_type = g.actor_type AND s.actor_id = g.actor_id
          AND s.subscription = c.subscription AND s.source_type = c.source_type
          AND s.source_id = c.source_id`
      : sql.literal("")

    const group: ReadonlyArray<Statement> = [
      ...begin,
      ...(grouped
        ? []
        : [
            cold
              ? Effect.asVoid(sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
                  SELECT ${routingKey}, ${tenant}, ${actor}, ${id}
                  FROM (SELECT ${timeouts}) AS timeouts
                  ON CONFLICT DO NOTHING`)
              : Effect.asVoid(sql`SELECT ${timeouts}`),
          ]),
      Effect.map(
        sql<Admission>`
          WITH locked AS MATERIALIZED (
            SELECT g.routing_key, g.tenant_id, g.actor_type, g.actor_id,
              g.generation, g.created, g.event_sequence
            FROM actor_generations g
            WHERE ${rowOf({ sql, actor: { key: routingKey, ref }, alias: "g" })}
            FOR UPDATE OF g ${grouped ? sql.literal("SKIP LOCKED") : sql.literal("")}
          )
          SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now,
            g.generation::text AS generation, g.created,
            c.payload::jsonb::text AS canonical,
            r.caller_key, r.command, r.payload_hash, r.outcome, g.event_sequence::text AS head
            ${
              warmTurns && Option.isSome(turns) && !grouped
                ? sql`, set_config('durable.turn_xid', pg_current_xact_id()::text, false) AS turn_xid`
                : sql.literal("")
            }
            ${cursorColumns}
          FROM locked g
          CROSS JOIN ${values}
          LEFT JOIN actor_receipts r ON r.routing_key = g.routing_key AND r.tenant_id = g.tenant_id
            AND r.actor_type = g.actor_type AND r.actor_id = g.actor_id AND r.command_id = c.command_id
          ${cursorJoin}
          ORDER BY c.ordinal`,
        (rows) => {
          admissions = rows
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
    ]

    const resume = Effect.fnUntraced(function* () {
      const first = admissions[0]

      if (first === undefined && grouped) return yield* Effect.die(new Unseated())

      if (first === undefined || (!cold && view.generation !== first.generation)) {
        forget(cache)

        return yield* Effect.die(RetryTurn.make({ message: "Stale actor generation" }))
      }

      const current = cold ? bumped! : first.generation
      const now = Number(first.now) + clock.offsetMillis()
      const { retryWindowMs } = yield* OutboxRuntime

      const expiryMarginMs = receiptMarginMs({
        keepReceiptsMs: policy.keepReceiptsMs,
        deliveryMs: policy.deliveryMs,
        retryWindowMs,
      })

      const ticks =
        !cold || cron.length === 0 ? Effect.succeed([]) : cronTicks(routingKey, ref, cron)

      const settled: Array<Settled> = Array.from({ length: batch.length })
      let next: Map<string, string> | undefined
      const dirty = new Map<string, string>()
      const removed = new Set<string>()
      const staged: Array<Statement> = []
      const receipts: Array<ReceiptRow> = []
      let created = first.created
      let creates = false
      let replayed = false
      let wake = false
      let needsAdmissionClock = false
      const broadcasts: Array<Broadcast> = []
      let events = 0
      let intents = 0
      let jobs = 0
      const eventTags = new Set<string>()
      const tables = new Set<string>()
      const blobs = new Set<string>()
      const replays = new Set<number>()
      const committed: Array<Omit<CommittedEvents, "emittedAtMs">> = []
      const emitted: Array<{ readonly emittedAtMs: number; readonly fed: boolean }> = []
      const cursors = new Map<string, Cursor>()

      const cursorKey = (delivery: SubscriptionDelivery) =>
        JSON.stringify([delivery.subscription, delivery.sourceType, delivery.sourceId])

      const cursorAt = (index: number, delivery: SubscriptionDelivery): Cursor =>
        cursors.get(cursorKey(delivery)) ?? admissions[index]!

      const apply = (index: number, delivery: SubscriptionDelivery) =>
        cursors.set(cursorKey(delivery), applied(delivery, cursorAt(index, delivery)))

      const outboxes: Array<OutboxReplies> = []

      /**
       * Admits one command of the batch once its payload hash is known: settles
       * a replay, an expiry, or a refusal and yields nothing, or yields the
       * hash its receipt records. A plain function rather than a generator,
       * because a generator built for every turn is compiled again and again as
       * the engine sees new copies of it.
       */
      const admitHashed = (index: number, hash: string) => {
        const { request, command } = batch[index]!
        const admitted = admissions[index]!

        if (admitted.outcome !== null)
          return Effect.map(
            checkReceipt(request, hash, admitted as StoredReceipt).pipe(Effect.result),
            (replay) => {
              if (Result.isSuccess(replay)) {
                replayed = true
                replays.add(index)
              }

              settled[index] = replay

              return undefined
            },
          )

        if (
          request.external === true &&
          Number(admitted.now) + (request.clockOffset ?? clock.offsetMillis()) >=
            commandTimes(request.commandId).expiresAt + expiryMarginMs
        ) {
          settled[index] = Result.fail(
            ActorError.make({ reason: CommandExpired.make({ commandId: request.commandId }) }),
          )

          return Effect.undefined
        }

        if (command.internal && !isSystem(request.caller))
          return Effect.die(new Error("Internal commands require a System caller"))

        const { delivery } = request

        const acknowledge = (reason: Acknowledgement) => {
          replayed = true
          settled[index] = Result.succeed(Outcome.cases.Acknowledged.make({ reason }))
        }

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
            return Effect.die(
              new Error("Subscription handlers accept only subscription deliveries"),
            )

          if (caller.ref.tenant !== tenant)
            return Effect.die(new Error("A subscription delivery crosses tenants"))

          const reason = acknowledgement(delivery, cursorAt(index, delivery))

          if (reason !== undefined) {
            acknowledge(reason)

            return Effect.undefined
          }
        }

        if (policy.createdBy !== undefined && !created && policy.createdBy !== request.command) {
          if (delivery !== undefined && delivery.epoch === "0" && delivery.kind === "event") {
            staged.push(applyCursor(delivery))
            apply(index, delivery)
            acknowledge("NotCreated")

            return Effect.undefined
          }

          settled[index] = Result.fail(ActorError.make({ reason: NotCreated.make({}) }))

          return Effect.undefined
        }

        if (
          !mintable ||
          policy.createdBy !== request.command ||
          created ||
          !isMintedId(parent === undefined ? id : (parseChildId(id)?.local ?? ""))
        )
          return Effect.succeed(hash)

        const refuse = () => {
          settled[index] = Result.fail(
            ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) }),
          )

          return undefined
        }

        return request.external === true
          ? Effect.sync(refuse)
          : Effect.map(committedMintIntent(request, parent), (committed) =>
              committed ? hash : refuse(),
            )
      }

      const admitOne = (index: number) => {
        if (optimistic !== undefined) return admitHashed(index, "")

        const request = batch[index]!.request
        const identityNow =
          Number(admissions[index]!.now) + (request.clockOffset ?? clock.offsetMillis())
        const hashed = Effect.flatMap(hashCanonical(admissions[index]!.canonical), (hash) =>
          admitHashed(index, hash),
        )

        if (request.external !== true) return hashed

        return Effect.flatMap(
          checkIdentity(request.commandId, retryWindowMs, identityNow).pipe(Effect.result),
          (identity) => {
            if (
              Result.isFailure(identity) &&
              (request.redelivered !== true || !Schema.is(CommandExpired)(identity.failure.reason))
            ) {
              settled[index] = Result.fail(identity.failure)

              return Effect.undefined
            }

            batch[index]!.admitted = true

            return hashed
          },
        )
      }

      let index = 0

      while (index < batch.length) {
        const { request, command } = batch[index]!
        const hash = yield* admitOne(index)

        if (hash === undefined) {
          index += 1
          continue
        }

        const start = index
        const members = [{ index, request, hash }]
        index += 1

        while (
          index < batch.length &&
          members.length < MERGE_CAP &&
          merges({ previous: batch[start]!, next: batch[index]! })
        ) {
          const joined = yield* admitOne(index)

          if (joined !== undefined)
            members.push({ index, request: batch[index]!.request, hash: joined })

          index += 1
        }

        next ??= readsState
          ? new Map(stored.map(({ key, value }) => [key, decompress(value)] as const))
          : new Map(view.state!)

        const given = next
        const head = String(BigInt(first.head) + BigInt(events))

        const savepoint = `SAVEPOINT ${HANDLER_SAVEPOINT}`

        if (statements && start > 0) yield* session.defer(savepoint)

        const business = yield* hooks.at("beforeHandler", request).pipe(
          Effect.andThen(() =>
            members.length === 1
              ? command.run(request, [...given], { head, connections })
              : command.merge!(
                  members.map((member) => member.request),
                  [...given],
                ),
          ),
          Effect.catchIf(SqlError.isSqlError, Effect.die),
          Effect.result,
        )

        const result: BusinessResult = Result.isSuccess(business)
          ? business.success
          : business.failure

        if (statements && (start === 0 || !session.withdraw(savepoint)))
          yield* session.defer(
            Result.isSuccess(business)
              ? `RELEASE SAVEPOINT ${HANDLER_SAVEPOINT}`
              : `ROLLBACK TO SAVEPOINT ${HANDLER_SAVEPOINT}`,
          )

        const written = new Map(result.state)

        if (result.complete)
          for (const key of given.keys())
            if (!written.has(key)) {
              given.delete(key)
              dirty.delete(key)
              removed.add(key)
            }

        for (const [key, value] of written) {
          given.set(key, value)
          dirty.set(key, value)
          removed.delete(key)
        }

        if (result.events.length > 0) {
          const appended = yield* eventsStatement(request, routingKey, result.events)
          staged.push(appended.statement)
          committed.push({
            after: head,
            events: result.events,
            commandId: request.commandId,
          })
          emitted.push(appended.stamp)
        }

        events += result.events.length

        for (const event of result.events) eventTags.add(event.tag)

        for (const table of result.writes?.tables ?? []) tables.add(table)

        for (const blob of result.writes?.blobs ?? []) blobs.add(blob)
        intents += result.outbox.intents.length
        jobs += result.outbox.jobs.length
        needsAdmissionClock ||=
          result.outbox.intents.length > 0 ||
          result.outbox.jobs.length > 0 ||
          result.outbox.subscriptions.length > 0

        if (Outcome.guards.Success(result.outcome)) broadcasts.push(...(result.broadcasts ?? []))

        if (yield* notifyEvents(request, routingKey, result.events, waited)) wake = true

        if (
          Outcome.guards.Success(result.outcome) &&
          policy.createdBy === request.command &&
          !created
        ) {
          created = true
          creates = true
        }

        const outbox = yield* outboxStatements(
          routingKey,
          request.ref,
          result.outbox,
          Effect.succeed(now),
          { slackMs: policy.executionMs },
        )

        staged.push(...outbox.statements)
        outboxes.push(outbox.replies)

        const { delivery } = request

        if (delivery !== undefined) {
          apply(start, delivery)
          staged.push(
            delivery.kind === "rejected"
              ? Effect.asVoid(sql`UPDATE actor_subscription_cursors SET active = false
                  WHERE ${cursorOf(delivery)} AND epoch = ${delivery.epoch}`)
              : delivery.epoch === "0"
                ? applyCursor(delivery)
                : Effect.asVoid(sql`UPDATE actor_subscription_cursors SET applied = ${delivery.position}
                    WHERE ${cursorOf(delivery)} AND epoch = ${delivery.epoch}`),
          )
        }

        const outcome = yield* encodeOutcome(result.outcome).pipe(Effect.orDie)

        for (const member of members) {
          receipts.push({
            routing_key: routingKey,
            tenant_id: tenant,
            actor_type: actor,
            actor_id: id,
            command_id: member.request.commandId,
            command: member.request.command,
            payload_hash: member.hash,
            caller_key: callerKey(member.request.caller),
            outcome,
            expires_at_ms: commandTimes(member.request.commandId).expiresAt,
            started_at_ms: Number(first.now),
          })
          yield* hooks.at("beforeCommit", member.request)
          settled[member.index] = Result.succeed(result.outcome)
        }
      }

      if (receipts.length === 0 && staged.length === 0 && !(cold && replayed))
        return {
          writes: undefined,
          settled,
          generation: current,
          state: view.state,
          created,
          needsAdmissionClock,
          wake: false,
          broadcasts: [],
          head: first.head,
          startedAtMs: Number(first.now),
          committed: [],
          emitted: [],
          outbox: [],
          replays,
          written: nothingWritten,
          wrote: nothingWrote,
        } satisfies Plan

      const writes: Array<Statement> = []

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

      if (removed.size > 0)
        writes.push(
          Effect.asVoid(
            sql`DELETE FROM actor_state WHERE ${actorRow} AND key IN ${sql.in([...removed])}`,
          ),
        )

      writes.push(...staged)

      if (creates)
        writes.push(
          Effect.asVoid(sql`UPDATE actor_generations SET created = true WHERE ${actorRow}`),
        )

      if (receipts.length > 0) {
        const receipt = receipts[0]!
        writes.push(
          Effect.asVoid(
            optimistic === undefined
              ? sql`INSERT INTO actor_receipts ${sql.insert(receipts)}`
              : sql`INSERT INTO actor_receipts (routing_key, tenant_id, actor_type, actor_id,
                  command_id, command, payload_hash, caller_key, outcome, expires_at_ms, started_at_ms)
                VALUES (${routingKey}, ${tenant}, ${actor}, ${id}, ${receipt.command_id},
                  ${receipt.command}, encode(sha256(convert_to(${batch[0]!.request.payload}::jsonb::text, 'UTF8')), 'hex'),
                  ${receipt.caller_key}, ${receipt.outcome}, ${receipt.expires_at_ms},
                  current_setting('durable.admitted_at_ms')::bigint)`,
          ),
        )

        if (accounting !== undefined)
          writes.push(
            accounting.commands({
              ref,
              commandIds: receipts.map((receipt) => receipt.command_id),
              sql,
            }),
          )
      }

      writes.push(...(yield* ticks))

      return {
        writes,
        settled,
        generation: current,
        state: next,
        created,
        needsAdmissionClock,
        wake,
        broadcasts,
        head: String(BigInt(first.head) + BigInt(events)),
        startedAtMs: Number(first.now),
        committed,
        emitted,
        outbox: outboxes,
        replays,
        written: { receipts: receipts.length, events, intents, jobs },
        wrote: {
          state: dirty.size > 0 || removed.size > 0,
          events: [...eventTags],
          tables: [...tables],
          blobs: [...blobs],
        },
      } satisfies Plan
    })

    return { group, resume }
  }

  const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.interruptible,
      Effect.timeoutOrElse({
        duration: policy.executionMs,
        orElse: () => Effect.die(RetryTurn.make({ message: "Command execution timeout" })),
      }),
      Effect.catchIf(SqlError.isSqlError, Effect.die),
    )

  const view = (): View => ({ generation: cache.generation, state: cache.state })

  let current: ReadonlyArray<W> = run.first
  let orphan: ReadonlyArray<W> | undefined
  let answering = false
  let poolRefused = false

  const locate = (batch: ReadonlyArray<W>, following: ReadonlyArray<W> | undefined) => {
    current = batch
    orphan = following
  }

  /**
   * Remembers what a commit proved and hands the ended batch to the
   * activation, which publishes it. Only a commit replaces the cache.
   */
  const finish = (
    batch: ReadonlyArray<W>,
    plan: Plan,
    version: string,
    endedAtMs: number,
    certified = false,
  ) =>
    Effect.suspend(() => {
      if (plan.writes !== undefined) {
        cache.generation = plan.generation
        cache.state = plan.state

        if (plan.state !== undefined) {
          const previous = cache.committed
          const receipts =
            previous?.generation === plan.generation ? previous.receipts : new Set<string>()
          let replayBefore =
            previous?.generation === plan.generation
              ? previous.replayBefore
              : plan.startedAtMs + clock.offsetMillis()

          for (const [index, settled] of plan.settled.entries())
            if (Result.isSuccess(settled)) receipts.add(batch[index]!.request.commandId)

          while (receipts.size > 1_024) {
            const oldest = receipts.values().next().value!
            replayBefore = Math.max(replayBefore, commandTimes(oldest).issuedAt)
            receipts.delete(oldest)
          }

          cache.committed = {
            generation: plan.generation,
            state: plan.state,
            created: plan.created,
            head: plan.head,
            version,
            certified,
            now: endedAtMs,
            replayBefore,
            receipts,
          }
        }
      }

      answering = true

      return run.committed(batch, {
        settled: plan.settled,
        broadcasts: plan.broadcasts,
        head: plan.head,
        committed: plan.committed.map((entry, index): CommittedEvents => ({
          ...entry,
          emittedAtMs: plan.emitted[index]!.emittedAtMs,
        })),
        cancelledJobs: plan.outbox.flatMap((replies) => replies.cancelledIds),
        generation: plan.generation,
        replays: plan.replays,
        written: plan.writes === undefined ? nothingWritten : plan.written,
        version,
        endedAtMs,
        startedAtMs: plan.startedAtMs,
        wrote: plan.writes === undefined ? nothingWrote : plan.wrote,
        wake:
          plan.wake ||
          plan.outbox.some((replies) => replies.wake) ||
          plan.emitted.some((stamp) => stamp.fed),
        cancelled: plan.outbox.some((replies) => replies.cancelled),
      })
    }).pipe(
      Effect.andThen(
        Effect.sync(() => {
          answering = false
        }),
      ),
    )

  /**
   * The one batch lifecycle both backends share. Each batch is located, so a
   * failure names it and any batch admitted behind it, and prepared before its
   * handlers can run; one whose admission is not yet under way is opened;
   * `transact` ends its transaction; and the ended batch is finished within its
   * own span before the next is taken. The next batch is the one `transact`
   * took while committing, whose admission may already ride behind this
   * `COMMIT`, else whatever is waiting once this batch was answered.
   * Opening stays lazy because preparation may acquire a generation and fill
   * the cache whose view admission uses.
   */
  const drive = <P, EO, RO, ET, RT>(
    open: (batch: ReadonlyArray<W>) => Effect.Effect<P, EO, RO>,
    transact: (batch: ReadonlyArray<W>, pending: P) => Effect.Effect<Ended<W, P>, ET, RT>,
  ) => {
    const step = (
      admitting: ReadonlyArray<W>,
      pending: P | undefined,
    ): Effect.Effect<void, EO | ET, RO | RT | RN | RP | RC> => {
      locate(admitting, undefined)

      return run.prepare.pipe(
        Effect.andThen(() => (pending === undefined ? open(admitting) : Effect.succeed(pending))),
        Effect.flatMap((admitted) =>
          transact(admitting, admitted).pipe(
            Effect.tap((ended) =>
              finish(admitting, ended.plan, ended.version, ended.endedAtMs, ended.certified),
            ),
            run.observe(admitting),
          ),
        ),
        Effect.flatMap((ended) =>
          ended.following === undefined
            ? Effect.flatMap(run.next, (next) =>
                next === undefined ? Effect.void : step(next, ended.chained),
              )
            : step(ended.following, ended.chained),
        ),
      )
    }

    return Effect.suspend(() => step(run.first, undefined))
  }

  /**
   * Postgres: a leased session per chain of batches. A batch is opened by
   * queuing `BEGIN` and its admission group; `transact` waits for those
   * replies, runs the handlers, takes the batch already waiting and, when this
   * one leaves the cache warm, queues that batch's `BEGIN` and admission right
   * behind this `COMMIT` in the same flight. The commit tag and version are read
   * in that flight too.
   *
   * A batch that chains nothing ends with every reply in and no transaction
   * open, so the session goes back to the pool before its callers are
   * answered; publishing never holds a session another turn waits for. A batch
   * that arrives later leases a session again.
   */
  const pipelined = (turns: TurnConnections["Service"]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        let lease:
          | { readonly connection: PgConnection.PgConnection; readonly scope: Scope.Closeable }
          | undefined

        const leased = Effect.suspend(() => {
          if (lease !== undefined) return Effect.void

          return Effect.gen(function* () {
            const held = yield* Scope.fork(scope)
            const leasing = yield* Clock.currentTimeMillis
            const connection = yield* Scope.provide(turns.lease, held).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  poolRefused = isPoolRefusal(error)
                }),
              ),
              Effect.onError((cause) => Scope.close(held, Exit.failCause(cause))),
            )
            yield* record(Metrics.poolWait, {}, (yield* Clock.currentTimeMillis) - leasing)
            lease = { connection, scope: held }
          })
        })

        const release = Effect.suspend(() => {
          const held = lease
          lease = undefined

          return held === undefined ? Effect.void : Scope.close(held.scope, Exit.void)
        })

        const session = () => lease!.connection
        let open = false
        const deferred: Array<string> = []

        const control = (text: string) => session().query(text, [], true)

        const flush = () => deferred.splice(0).map((text) => Effect.asVoid(control(text)))

        const send: Send = <A>(statement: Effect.Effect<A, SqlError.SqlError>) =>
          Effect.suspend(() => {
            if (deferred.length === 0) return statement

            let reply: { readonly value: A } | undefined

            return sendPipelined([
              ...flush(),
              Effect.map(statement, (value) => {
                reply = { value }
              }),
            ]).pipe(Effect.map(() => reply!.value))
          })

        const pipeline: Session = {
          send: sendPipelined,
          control: (text) => Effect.asVoid(control(text)),
          defer: (text) =>
            Effect.sync(() => {
              deferred.push(text)
            }),
          withdraw: (text) => deferred.at(-1) === text && deferred.pop() !== undefined,
        }

        const begin = Effect.suspend(() => {
          open = true

          return Effect.asVoid(control("BEGIN"))
        })

        const inTurn = <A, E, R2>(effect: Effect.Effect<A, E, R2>) =>
          Effect.suspend(() =>
            Effect.provideService(effect, sql.transactionService, [
              asSqlConnection({ connection: session(), send }),
              0,
            ]),
          )

        interface Admitting {
          readonly admission: ReturnType<typeof admit>
          readonly admitted: Effect.Success<ReturnType<typeof queueStatements>>
          readonly optimistic?: NonNullable<ActivationCache["committed"]>
          /** The batch's place in a turn group, whose session carries its admission. */
          readonly member?: Member
        }

        const queue = (batch: ReadonlyArray<W>, view: View, ahead: ReadonlyArray<Statement>) =>
          Effect.flatMap(canonicalsOf(batch), (canonicals) => {
            const admission = admit(batch, canonicals, view, pipeline, [begin])

            return Effect.map(
              queueStatements({ scope, group: [...ahead, ...admission.group] }),
              (flight) => ({ admission, flight }),
            )
          })

        /**
         * A post-COMMIT LSN is not an applied WAL prefix for a memory snapshot.
         * After reading it, a read-only probe must exclude a foreign writer,
         * including one whose commit record is inserted but not yet visible.
         * Such a writer changes the generation row's xmax before its commit;
         * a plain snapshot-only metadata check would miss that interval.
         */
        const certify = (plan: Plan) => sql<{ certified: boolean }>`SELECT EXISTS (
          SELECT 1 FROM actor_generations g
          WHERE ${rowOf({ sql, actor: { key: routingKey, ref }, alias: "g" })}
            AND g.generation = ${plan.generation} AND g.created = ${plan.created}
            AND g.event_sequence = ${plan.head} AND to_jsonb(g)->>'cold_ref' IS NULL
            AND g.xmax::text IN ('0', (current_setting('durable.turn_xid')::bigint % 4294967296)::text)
        ) AS certified`

        /**
         * Queues a batch's commit group, and the next batch's admission behind
         * it when the cache stays warm, then waits for the commit replies.
         */
        const commitPlan = (
          batch: ReadonlyArray<W>,
          plan: Plan,
          following: ReadonlyArray<W> | undefined,
        ) => {
          const ending = plan.writes === undefined ? "ROLLBACK" : "COMMIT"

          const after: View =
            plan.writes === undefined ? view() : { generation: plan.generation, state: plan.state }

          const chained =
            following !== undefined &&
            after.generation !== undefined &&
            after.state !== undefined &&
            !run.publishesUnderLock(batch)

          let tag: string | undefined
          let version = ""
          let endedAtMs = 0
          let certified = false

          const commit: ReadonlyArray<Statement> = [
            ...(plan.writes === undefined ? [] : [...flush(), ...plan.writes]),
            Effect.map(control(ending), (result) => {
              tag = result.command

              if (!chained) open = false
            }),
            Effect.map(session().query(COMMIT_VERSION, [], true), (result) => {
              const ended = result.rows[0] as { version: string; now: string }
              version = ended.version
              endedAtMs = Number(ended.now)
            }),
            ...(warmTurns && plan.writes !== undefined && plan.state !== undefined
              ? [
                  Effect.map(certify(plan), (rows) => {
                    certified = rows[0]!.certified
                  }),
                ]
              : []),
          ]

          locate(batch, following)

          const upcoming: Effect.Effect<{
            readonly admission: Admitting["admission"] | undefined
            readonly flight: Admitting["admitted"]
          }> = chained
            ? queue(following, after, commit)
            : Effect.map(queueStatements({ scope, group: commit }), (flight) => ({
                admission: undefined,
                flight,
              }))

          return Effect.flatMap(upcoming, ({ admission: next, flight }) => {
            const answered = awaitReplies(flight.slice(0, commit.length))

            return Effect.map(
              ending === "COMMIT" ? answered.pipe(Effect.withSpan(SpanNames.commit)) : answered,
              () => ({
                plan,
                version,
                endedAtMs,
                certified,
                ending,
                tag,
                following,
                chained:
                  next === undefined
                    ? undefined
                    : { admission: next, admitted: flight.slice(commit.length) },
              }),
            )
          })
        }

        const alone = (
          batch: ReadonlyArray<W>,
          { admission, admitted }: Admitting,
          taken?: ReadonlyArray<W>,
        ) =>
          awaitReplies(admitted).pipe(
            Effect.andThen(() => admission.resume()),
            Effect.flatMap((plan) =>
              Effect.flatMap(taken === undefined ? run.next : Effect.succeed(taken), (following) =>
                commitPlan(batch, plan, following),
              ),
            ),
            inTurn,
            bounded,
            Effect.filterOrElse(
              (stepped) => stepped.ending !== "COMMIT" || stepped.tag === "COMMIT",
              () => Effect.die(RetryTurn.make({ message: "Turn commit rolled back" })),
            ),
            Effect.tap((stepped) => (stepped.chained === undefined ? release : Effect.void)),
          )

        const openAlone = (batch: ReadonlyArray<W>) =>
          leased.pipe(
            Effect.andThen(queue(batch, view(), []).pipe(inTurn)),
            Effect.map(({ admission, flight }): Admitting => ({ admission, admitted: flight })),
          )

        /**
         * A speculative plan uses only an already committed snapshot. The
         * guard's deliberate division by zero aborts every pipelined write on
         * a miss; the receipt's unique constraint also catches a commit that
         * became visible after the guard's statement snapshot. Recovery then
         * uses ordinary admission, never trusting an unconfirmed outcome.
         */
        const optimistic = (
          batch: ReadonlyArray<W>,
          admitting: Admitting,
          committed: NonNullable<ActivationCache["committed"]>,
        ) => {
          const { request } = batch[0]!
          const { issuedAt, expiresAt } = commandTimes(request.commandId)
          const identityOffset = request.clockOffset ?? clock.offsetMillis()
          const ordinary = () => Effect.flatMap(openAlone(batch), (opened) => alone(batch, opened))

          return admitting.admission.resume().pipe(
            Effect.catchDefect((defect) =>
              Schema.is(RetryTurn)(defect) || SqlError.isSqlError(defect)
                ? Effect.die(defect)
                : Effect.void,
            ),
            Effect.flatMap((plan) => {
              if (plan === undefined || plan.writes === undefined || plan.needsAdmissionClock)
                return ordinary()

              let missed = false
              let tag = ""
              let version = ""
              let endedAtMs = 0
              let startedAtMs = 0
              let certified = false

              const guard = sql<{ now: string }>`
                WITH locked AS MATERIALIZED (
                  SELECT g.generation, g.created, g.event_sequence,
                    to_jsonb(g)->>'cold_ref' AS cold_ref
                  FROM actor_generations g
                  WHERE ${rowOf({ sql, actor: { key: routingKey, ref }, alias: "g" })}
                  FOR UPDATE OF g
                ), checked AS MATERIALIZED (
                  SELECT *, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now
                  FROM locked
                )
                SELECT 1 / CASE WHEN EXISTS (
                  SELECT 1 FROM checked g
                  WHERE g.generation = ${committed.generation} AND g.created = ${committed.created}
                    AND g.event_sequence = ${committed.head}
                    AND g.cold_ref IS NULL
                    AND NOT EXISTS (SELECT 1 FROM actor_receipts WHERE ${actorRow}
                      AND command_id = ${request.commandId})
                    AND (${request.external !== true} OR
                      (g.now + ${identityOffset} >= ${issuedAt} AND g.now + ${identityOffset} < ${expiresAt}))
                ) THEN 1 ELSE 0 END AS accepted,
                (SELECT set_config('durable.admitted_at_ms', now::text, true) FROM checked) AS now,
                set_config('durable.turn_xid', pg_current_xact_id()::text, false) AS turn_xid`

              const flight = [
                begin,
                Effect.asVoid(sql`SELECT ${timeouts}`),
                Effect.map(guard, (rows) => {
                  startedAtMs = Number(rows[0]!.now)
                  if (request.external === true) batch[0]!.admitted = true
                }).pipe(
                  Effect.tapError((error) =>
                    Effect.sync(() => {
                      missed = Schema.is(Schema.Struct({ code: Schema.Literal("22012") }))(
                        error.reason.cause,
                      )
                    }),
                  ),
                ),
                ...plan.writes,
                Effect.map(control("COMMIT"), (result) => {
                  tag = result.command
                  open = false
                }),
                Effect.map(session().query(COMMIT_VERSION, [], true), (result) => {
                  const ended = result.rows[0] as { version: string; now: string }
                  version = ended.version
                  endedAtMs = Number(ended.now)
                }),
                Effect.map(certify(plan), (rows) => {
                  certified = rows[0]!.certified
                }),
              ]

              return sendPipelined(flight).pipe(
                Effect.withSpan(SpanNames.commit),
                Effect.as(true),
                Effect.catch((error) => {
                  const duplicate = Schema.is(
                    Schema.Struct({
                      code: Schema.Literal("23505"),
                      constraint: Schema.Literal("actor_receipts_pkey"),
                    }),
                  )(error.reason.cause)

                  return (missed || duplicate) && tag === "ROLLBACK"
                    ? Effect.succeed(false)
                    : Effect.fail(error)
                }),
                Effect.flatMap(
                  (
                    accepted,
                  ): Effect.Effect<
                    Ended<W, Admitting>,
                    SqlError.SqlError,
                    Effect.Services<ReturnType<typeof alone>>
                  > => {
                    if (!accepted) {
                      forget(cache)
                      return ordinary()
                    }

                    if (tag !== "COMMIT")
                      return Effect.die(RetryTurn.make({ message: "Warm turn commit rolled back" }))

                    return Effect.as(release, {
                      plan: { ...plan, startedAtMs },
                      version,
                      endedAtMs,
                      certified,
                    } satisfies Ended<W, Admitting>)
                  },
                ),
              )
            }),
            inTurn,
            bounded,
          )
        }

        const onMember =
          (member: Member) =>
          <A, E, R2>(effect: Effect.Effect<A, E, R2>) =>
            Effect.suspend(() =>
              Effect.provideService(effect, sql.transactionService, [
                asSqlConnection({ connection: member.connection(), send: member.send }),
                0,
              ]),
            )

        /**
         * Joins the forming group for this batch's settings with its fenced
         * admission read alone; the group opens the transaction.
         */
        const openGrouped = (batch: ReadonlyArray<W>, joining: TurnGroups["Service"]) =>
          Effect.flatMap(canonicalsOf(batch), (canonicals) => {
            const admission = admit(batch, canonicals, view(), pipeline, [], true)

            return joining
              .join({
                key: groupKey,
                settings: (connection) =>
                  Effect.provideService(
                    Effect.asVoid(sql`SELECT ${timeouts}`),
                    sql.transactionService,
                    [asSqlConnection({ connection, send: (statement) => statement }), 0],
                  ),
                cancel: (connection) =>
                  Effect.ignore(sql`SELECT pg_cancel_backend(${connection.processId})`),
                admission: (member) => admission.group.map(onMember(member)),
              })
              .pipe(
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    poolRefused = isPoolRefusal(error)
                  }),
                ),
                Effect.map((member): Admitting => ({ admission, admitted: [], member })),
              )
          })

        /**
         * A grouped batch: its own admission replies, its handlers, and its
         * writes handed to the group, answered once the group commits. When
         * the actor's next batch is already waiting and this one leaves the
         * cache warm, that batch's admission rides behind the group's
         * `COMMIT` and the batch takes the group's session, as a batch on its
         * own session would. `ended` is undefined when the batch must run again
         * alone: the group ended without it, aborted on a neighbour's
         * statement, skipped its locked generation row, or the batch tried to
         * send another statement.
         */
        const grouped = (
          batch: ReadonlyArray<W>,
          admission: ReturnType<typeof admit>,
          member: Member,
        ) => {
          let following: ReadonlyArray<W> | undefined

          return Effect.gen(function* () {
            const replies = yield* Effect.exit(awaitReplies(member.replies()))

            if (Exit.isFailure(replies)) {
              yield* member.leave(true)
              const error = errorOf(replies)

              if (error !== undefined && abortedBefore(error)) return undefined

              return yield* Effect.failCause(replies.cause)
            }

            if (!(yield* member.handling)) return undefined

            const plan = yield* onMember(member)(admission.resume())
            following = yield* run.next
            locate(batch, following)

            const after: View =
              plan.writes === undefined
                ? view()
                : { generation: plan.generation, state: plan.state }

            let next: ReturnType<typeof admit> | undefined

            const handoff =
              following !== undefined &&
              after.generation !== undefined &&
              after.state !== undefined &&
              !run.publishesUnderLock(batch)
                ? yield* Effect.map(canonicalsOf(following), (canonicals) => ({
                    chain: (connection: PgConnection.PgConnection) => {
                      const on = <A, E, R2>(effect: Effect.Effect<A, E, R2>) =>
                        Effect.provideService(effect, sql.transactionService, [
                          asSqlConnection({ connection, send }),
                          0,
                        ])
                      next = admit(following!, canonicals, after, pipeline, [
                        Effect.asVoid(connection.query("BEGIN", [], true)),
                      ])

                      return next.group.map(on)
                    },
                    adopt: (connection: PgConnection.PgConnection, held: Scope.Closeable) =>
                      Effect.suspend(() => {
                        if (Predicate.isTagged(scope.state, "Closed")) return Effect.succeed(false)

                        lease = { connection, scope: held }
                        open = true

                        return Effect.as(
                          Scope.addFinalizer(scope, Scope.close(held, Exit.void)),
                          true,
                        )
                      }),
                  }))
                : undefined

            const writes = (plan.writes ?? []).map(onMember(member))
            const waiting = member.commit(writes, handoff)
            const shared = yield* writes.length > 0
              ? waiting.pipe(Effect.withSpan(SpanNames.commit))
              : waiting

            if (Shared.$is("Alone")(shared)) return undefined

            return {
              plan,
              version: shared.version,
              endedAtMs: shared.endedAtMs,
              following,
              chained:
                shared.chained === undefined || next === undefined
                  ? undefined
                  : { admission: next, admitted: [...shared.chained] },
            } satisfies Ended<W, Admitting>
          }).pipe(
            Effect.catchDefect((defect) =>
              defect instanceof Unseated ? Effect.undefined : Effect.die(defect),
            ),
            Effect.onExit(() => member.leave(false)),
            bounded,
            Effect.map((ended) => ({ ended, following })),
          )
        }

        const transact = (batch: ReadonlyArray<W>, admitting: Admitting) =>
          admitting.optimistic !== undefined
            ? optimistic(batch, admitting, admitting.optimistic)
            : admitting.member === undefined
              ? alone(batch, admitting)
              : Effect.flatMap(
                  grouped(batch, admitting.admission, admitting.member),
                  (
                    outcome,
                  ): Effect.Effect<
                    Ended<W, Admitting>,
                    SqlError.SqlError,
                    Effect.Services<ReturnType<typeof alone>>
                  > =>
                    outcome.ended !== undefined
                      ? Effect.succeed(outcome.ended)
                      : Effect.flatMap(openAlone(batch), (opened) =>
                          alone(batch, opened, outcome.following),
                        ),
                )

        let first = true

        return yield* drive((batch) => {
          const snapshot = cache.committed
          const { request, command } = batch[0]!
          const fast =
            warmTurns &&
            batch.length === 1 &&
            snapshot !== undefined &&
            snapshot.generation === cache.generation &&
            snapshot.state === cache.state &&
            !statements &&
            waited.size === 0 &&
            connections === undefined &&
            !run.publishesUnderLock(batch) &&
            !command.handler &&
            (!command.internal || isSystem(request.caller)) &&
            request.delivery === undefined &&
            request.redelivered !== true &&
            commandTimes(request.commandId).issuedAt > snapshot.replayBefore &&
            !snapshot.receipts.has(request.commandId) &&
            (policy.createdBy === undefined || snapshot.created)

          const joining =
            first && view().generation !== undefined && view().state !== undefined
              ? groups
              : undefined
          first = false

          if (fast)
            return leased.pipe(
              Effect.map((): Admitting => ({
                admission: admit(batch, [], view(), pipeline, [], false, {
                  now: String(snapshot.now),
                  generation: snapshot.generation,
                  created: snapshot.created,
                  canonical: request.payload,
                  caller_key: null,
                  command: null,
                  payload_hash: null,
                  outcome: null,
                  head: snapshot.head,
                }),
                admitted: [],
                optimistic: snapshot,
              })),
            )

          return joining === undefined ? openAlone(batch) : openGrouped(batch, joining)
        }, transact).pipe(
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit) || !open) return Effect.void

            const connection = session()

            if (Cause.hasInterrupts(exit.cause))
              return sql`SELECT pg_cancel_backend(${connection.processId})`.pipe(
                Effect.ignore,
                Effect.andThen(turns.invalidate(connection)),
              )

            return control("ROLLBACK").pipe(
              Effect.flatMap((result) =>
                result.command === "ROLLBACK" ? Effect.void : turns.invalidate(connection),
              ),
              Effect.catch(() => turns.invalidate(connection)),
            )
          }),
        )
      }),
    )

  /**
   * PGlite: one in-process session and nothing to pipeline, so each batch runs
   * its groups one statement at a time inside `withTransaction`, which holds
   * the session only for that transaction; a batch with nothing to commit rolls
   * back. The commit version is read after the transaction ends.
   */
  const sequential = drive(
    () => Effect.void,
    (batch) =>
      Effect.gen(function* () {
        const control = (text: string) => Effect.asVoid(sql.unsafe(text))
        const session = { send: sendSequentially, control, defer: control, withdraw: () => false }

        const plan: Plan = yield* bounded(
          sql
            .withTransaction(
              Effect.gen(function* () {
                const admission = admit(batch, yield* canonicalsOf(batch), view(), session, [])

                yield* sendSequentially(admission.group)
                const decided = yield* admission.resume()

                if (decided.writes === undefined) return yield* Effect.fail(new RolledBack(decided))

                yield* sendSequentially(decided.writes).pipe(Effect.withSpan(SpanNames.commit))

                return decided
              }),
            )
            .pipe(
              Effect.catchIf(
                (error) => error instanceof RolledBack,
                (rolled) => Effect.succeed(rolled.plan),
              ),
            ),
        )

        const [ended] = yield* sql.unsafe<{ version: string; now: string }>(COMMIT_VERSION)

        return {
          plan,
          version: ended!.version,
          endedAtMs: Number(ended!.now),
          certified: true,
        }
      }),
  )

  const turns = yield* Effect.serviceOption(TurnConnections)

  const groups =
    statements || waited.size > 0
      ? undefined
      : Option.getOrUndefined(yield* Effect.serviceOption(TurnGroups))

  const exit = yield* (Option.isSome(turns) ? pipelined(turns.value) : sequential).pipe(
    Effect.onError(() =>
      Effect.sync(() => {
        cache.state = undefined
        cache.committed = undefined
      }),
    ),
    Effect.exit,
  )

  if (Exit.isSuccess(exit)) return undefined

  if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause)

  return {
    batch: current,
    orphan,
    cause: exit.cause,
    committed: answering,
    poolRefused,
  } satisfies Stopped<W>
})
