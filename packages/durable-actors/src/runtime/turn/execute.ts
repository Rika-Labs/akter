import { Cause, Clock, Crypto, Effect, Exit, Option, Result, Schema } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
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
import { compress, decompress, routingKey as routingKeyOf } from "../storage/codec.ts"
import { recordedPlacement } from "../storage/placements.ts"
import { Metrics, record } from "../telemetry/metrics.ts"
import { SpanNames } from "../telemetry/spans.ts"
import { receiptMarginMs } from "../storage/retention.ts"
import { hashedPayload } from "../subscriptions/identity.ts"
import { tenantSettings, TenantScope } from "../database/tenancy.ts"
import { type ActivationCache, actorRow as rowOf, forget } from "../storage/generation.ts"
import { databaseTime, FrameworkClock } from "./admission.ts"
import { RetryTurn, TurnHooks } from "./hooks.ts"
import { CallerJson, OutboxRuntime, type OutboxReplies, outboxStatements } from "./outbox.ts"
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

/**
 * True when `request` is a minted actor's creating intent: its caller carries
 * the parent's mint proof for the actor's id, and the parent's committed
 * outbox still holds that exact intent with the same payload. The read names
 * the parent's routing key, which a parent-placed actor shares and any other
 * actor gets from the parent type's recorded placement, so it is one keyed
 * statement rather than a scan of every shard.
 */
const committedMintIntent = Effect.fnUntraced(function* (
  request: Request,
  parent: string | undefined,
  routingKey: bigint,
) {
  const { caller, ref } = request

  if (!isSystem(caller) || caller.ref === undefined || !(yield* provesMint(caller, ref, parent)))
    return false

  const sql = yield* SqlClient.SqlClient

  const parentPlacement =
    parent === undefined ? yield* recordedPlacement(caller.ref.actor) : undefined

  if (parent === undefined && parentPlacement === undefined) return false

  const parentKey =
    parentPlacement === undefined
      ? routingKey
      : routingKeyOf({ ref: caller.ref, placement: parentPlacement })

  const rows = yield* sql<{ caller: string }>`SELECT caller FROM actor_outbox
    WHERE intent_id = ${request.commandId} AND kind = 'intent' AND tenant_id = ${ref.tenant}
      AND actor_type = ${caller.ref.actor} AND actor_id = ${caller.ref.id}
      AND target_type = ${ref.actor} AND target_id = ${ref.id} AND command = ${request.command}
      AND payload::jsonb = ${request.payload}::jsonb AND routing_key = ${parentKey}`

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
  /** A workflow waits on an emitted class, so the relay should wake after commit. */
  readonly wake: boolean
  /** Broadcasts the batch's committed successes publish to the actor's connections. */
  readonly broadcasts: ReadonlyArray<Broadcast>
  /** The actor's event sequence once this batch commits. */
  readonly head: string
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
}

/** Rows a committed turn adds; nothing when it replays, acknowledges, or rolls back. */
export interface Written {
  readonly receipts: number
  readonly events: number
  readonly intents: number
  readonly effects: number
}

const nothingWritten: Written = { receipts: 0, events: 0, intents: 0, effects: 0 }

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
  /** Started effects the batch's commands cancelled. */
  readonly cancelledEffects: ReadonlyArray<string>
  readonly generation: string
  /** The positions in `settled` that answered from a stored receipt. */
  readonly replays: ReadonlySet<number>
  /** Rows the batch committed; none when it rolled back. */
  readonly written: Written
  /** The commit version each caller's later queries wait for. */
  readonly version: string
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
  readonly following?: ReadonlyArray<W> | undefined
  readonly chained?: P | undefined
}

/**
 * Consecutive batches of one activation. `next` takes the batch already
 * waiting, if any, without waiting for one; `prepare` runs before each
 * batch's handlers, and `committed` once the batch commits or rolls back,
 * before the next batch's handlers run.
 */
interface Run<W extends Delivery, RN, RP, RC> {
  readonly first: ReadonlyArray<W>
  readonly next: Effect.Effect<ReadonlyArray<W> | undefined, never, RN>
  readonly prepare: Effect.Effect<void, never, RP>
  readonly committed: (batch: ReadonlyArray<W>, done: Done) => Effect.Effect<void, never, RC>
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
}

class RolledBack {
  constructor(readonly plan: Plan) {}
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
 * Admission checks. An external command still runs past expiry, but not once
 * retention cleanup may have pruned a receipt of its id that committed
 * meanwhile, or the expired id would run again. Only the relay's subscription
 * deliveries reach a handler, and only a handler takes one, so no caller
 * reaches it around the cursor or route. A routed event for a subscriber its
 * creating command has not created is skipped, and its cursor keeps a stale
 * redelivery from running after another command creates the subscriber. A
 * minted actor is created only by the relay delivering the creating intent
 * its parent's turn staged and committed: the mint proof binds the id to the
 * parent's command, and the parent's outbox row, which stays until its
 * delivery commits, proves that command committed the intent.
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
 * locks the generation row. N's callers are answered once its `COMMIT` reply
 * arrives, and the next batch's handlers run only once its own fence and
 * receipt replies arrive. If N's commit fails, the next batch's transaction
 * is rolled back unseen with it. The commit version is read on the same
 * session after the transaction ends, in the same flight, so it covers the
 * batch's commit record and any receipt it replayed.
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
) {
  const sql = yield* SqlClient.SqlClient
  const hooks = yield* TurnHooks
  const clock = yield* FrameworkClock
  const scope = yield* TenantScope
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

  const admit = (
    batch: ReadonlyArray<Delivery>,
    canonicals: ReadonlyArray<string>,
    view: View,
    session: Session,
    begin: ReadonlyArray<Statement>,
  ) => {
    const cold = view.generation === undefined

    const timeouts = sql`set_config('lock_timeout', ${`${policy.lockWaitMs}ms`}, true),
      set_config('statement_timeout', ${`${policy.executionMs}ms`}, true),
      set_config('durable.turn', 'on', true)
      ${role === undefined ? sql.literal("") : sql`, ${tenantSettings({ sql, role, tenant })}`}`

    const readsState = cold || view.state === undefined
    let admissions: ReadonlyArray<Admission> = []
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
            c.payload::jsonb::text AS canonical,
            r.caller_key, r.command, r.payload_hash, r.outcome, g.event_sequence::text AS head
            ${cursorColumns}
          FROM actor_generations g
          CROSS JOIN ${values}
          LEFT JOIN actor_receipts r ON r.routing_key = g.routing_key AND r.tenant_id = g.tenant_id
            AND r.actor_type = g.actor_type AND r.actor_id = g.actor_id AND r.command_id = c.command_id
          ${cursorJoin}
          WHERE ${rowOf({ sql, actor: { key: routingKey, ref }, alias: "g" })}
          ORDER BY c.ordinal
          FOR UPDATE OF g`,
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

      const ticks = Effect.gen(function* () {
        if (!cold || cron.length === 0) return []

        const now = yield* databaseTime
        const services = yield* Effect.context<SqlClient.SqlClient | Crypto.Crypto>()

        return [writeTicks(routingKey, ref, cron, now).pipe(Effect.provideContext(services))]
      })

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
      const broadcasts: Array<Broadcast> = []
      let events = 0
      let intents = 0
      let effects = 0
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

      const admitOne = Effect.fnUntraced(function* (index: number) {
        const { request, command } = batch[index]!
        const admitted = admissions[index]!
        const hash = yield* hashCanonical(admitted.canonical)

        if (admitted.outcome !== null) {
          const replay = yield* checkReceipt(request, hash, admitted as StoredReceipt).pipe(
            Effect.result,
          )

          if (Result.isSuccess(replay)) {
            replayed = true
            replays.add(index)
          }

          settled[index] = replay

          return undefined
        }

        if (
          request.external === true &&
          now >= commandTimes(request.commandId).expiresAt + expiryMarginMs
        ) {
          settled[index] = Result.fail(
            ActorError.make({ reason: CommandExpired.make({ commandId: request.commandId }) }),
          )

          return undefined
        }

        if (command.internal && !isSystem(request.caller))
          return yield* Effect.die(new Error("Internal commands require a System caller"))

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
            return yield* Effect.die(
              new Error("Subscription handlers accept only subscription deliveries"),
            )

          if (caller.ref.tenant !== tenant)
            return yield* Effect.die(new Error("A subscription delivery crosses tenants"))

          const reason = acknowledgement(delivery, cursorAt(index, delivery))

          if (reason !== undefined) {
            acknowledge(reason)

            return undefined
          }
        }

        if (policy.createdBy !== undefined && !created && policy.createdBy !== request.command) {
          if (delivery !== undefined && delivery.epoch === "0" && delivery.kind === "event") {
            staged.push(applyCursor(delivery))
            apply(index, delivery)
            acknowledge("NotCreated")

            return undefined
          }

          settled[index] = Result.fail(ActorError.make({ reason: NotCreated.make({}) }))

          return undefined
        }

        if (
          mintable &&
          policy.createdBy === request.command &&
          !created &&
          isMintedId(parent === undefined ? id : (parseChildId(id)?.local ?? "")) &&
          (request.external === true || !(yield* committedMintIntent(request, parent, routingKey)))
        ) {
          settled[index] = Result.fail(
            ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) }),
          )

          return undefined
        }

        return hash
      })

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

        const business = yield* Effect.gen(function* () {
          yield* hooks.at("beforeHandler", request)

          return members.length === 1
            ? yield* command.run(request, [...given], { head, connections })
            : yield* command.merge!(
                members.map((member) => member.request),
                [...given],
              )
        }).pipe(Effect.catchIf(SqlError.isSqlError, Effect.die), Effect.result)

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
        effects += result.outbox.jobs.length

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
          wake: false,
          broadcasts: [],
          head: first.head,
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

      if (receipts.length > 0)
        writes.push(Effect.asVoid(sql`INSERT INTO actor_receipts ${sql.insert(receipts)}`))

      writes.push(...(yield* ticks))

      return {
        writes,
        settled,
        generation: current,
        state: next,
        wake,
        broadcasts,
        head: String(BigInt(first.head) + BigInt(events)),
        committed,
        emitted,
        outbox: outboxes,
        replays,
        written: { receipts: receipts.length, events, intents, effects },
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

  const locate = (batch: ReadonlyArray<W>, following: ReadonlyArray<W> | undefined) => {
    current = batch
    orphan = following
  }

  /**
   * Remembers what a commit proved and hands the ended batch to the
   * activation, which publishes it. Only a commit replaces the cache.
   */
  const finish = Effect.fnUntraced(function* (
    batch: ReadonlyArray<W>,
    plan: Plan,
    version: string,
  ) {
    if (plan.writes !== undefined) {
      cache.generation = plan.generation
      cache.state = plan.state
    }

    answering = true

    yield* run.committed(batch, {
      settled: plan.settled,
      broadcasts: plan.broadcasts,
      head: plan.head,
      committed: plan.committed.map((entry, index): CommittedEvents => ({
        ...entry,
        emittedAtMs: plan.emitted[index]!.emittedAtMs,
      })),
      cancelledEffects: plan.outbox.flatMap((replies) => replies.cancelledIds),
      generation: plan.generation,
      replays: plan.replays,
      written: plan.writes === undefined ? nothingWritten : plan.written,
      version,
      wrote: plan.writes === undefined ? nothingWrote : plan.wrote,
      wake:
        plan.wake ||
        plan.outbox.some((replies) => replies.wake) ||
        plan.emitted.some((stamp) => stamp.fed),
      cancelled: plan.outbox.some((replies) => replies.cancelled),
    })

    answering = false
  })

  /**
   * The one batch lifecycle both backends share. Each batch is located, so a
   * failure names it and any batch admitted behind it, and prepared before its
   * handlers can run; one whose admission is not yet under way is opened;
   * `transact` ends its transaction; and the ended batch is finished within its
   * own span before the next is taken. The next batch is the one `transact`
   * took while committing, whose admission may already ride behind this
   * `COMMIT`, else whatever is waiting once this batch was answered.
   */
  const drive = <P, EO, RO, ET, RT>(
    open: (batch: ReadonlyArray<W>) => Effect.Effect<P, EO, RO>,
    transact: (batch: ReadonlyArray<W>, pending: P) => Effect.Effect<Ended<W, P>, ET, RT>,
  ) =>
    Effect.gen(function* () {
      let batch: ReadonlyArray<W> | undefined = run.first
      let pending: P | undefined

      while (batch !== undefined) {
        const admitting: ReadonlyArray<W> = batch
        locate(admitting, undefined)

        yield* run.prepare
        pending ??= yield* open(admitting)

        const admitted = pending

        const ended: Ended<W, P> = yield* Effect.gen(function* () {
          const step: Ended<W, P> = yield* transact(admitting, admitted)
          yield* finish(admitting, step.plan, step.version)

          return step
        }).pipe(run.observe(admitting))

        pending = ended.chained
        batch = ended.following ?? (yield* run.next)
      }
    })

  /**
   * Postgres: one leased session for the whole run. A batch is opened by
   * queuing `BEGIN` and its admission group; `transact` waits for those
   * replies, runs the handlers, takes the batch already waiting and, when this
   * one leaves the cache warm, queues that batch's `BEGIN` and admission right
   * behind this `COMMIT` in the same flight. The commit tag and version are read
   * in that flight too.
   */
  const pipelined = (turns: TurnConnections["Service"]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const leasing = yield* Clock.currentTimeMillis
        const connection = yield* turns.lease
        yield* record(Metrics.poolWait, {}, (yield* Clock.currentTimeMillis) - leasing)
        let open = false
        const deferred: Array<string> = []

        const control = (text: string) => connection.query(text, [], true)

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

        const session: Session = {
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
          Effect.provideService(effect, sql.transactionService, [
            asSqlConnection({ connection, send }),
            0,
          ])

        interface Admitting {
          readonly admission: ReturnType<typeof admit>
          readonly admitted: Effect.Success<ReturnType<typeof queueStatements>>
        }

        const queue = (batch: ReadonlyArray<W>, view: View, ahead: ReadonlyArray<Statement>) =>
          Effect.gen(function* () {
            const admission = admit(batch, yield* canonicalsOf(batch), view, session, [begin])
            const flight = yield* queueStatements({ scope, group: [...ahead, ...admission.group] })

            return { admission, flight }
          })

        const transact = (batch: ReadonlyArray<W>, { admission, admitted }: Admitting) =>
          Effect.gen(function* () {
            const stepped = yield* Effect.gen(function* () {
              yield* awaitReplies(admitted)
              const plan = yield* admission.resume()
              const following = yield* run.next
              const ending = plan.writes === undefined ? "ROLLBACK" : "COMMIT"

              const after: View =
                plan.writes === undefined
                  ? view()
                  : { generation: plan.generation, state: plan.state }

              const chained =
                following !== undefined &&
                after.generation !== undefined &&
                after.state !== undefined

              let tag: string | undefined
              let version = ""

              const commit: ReadonlyArray<Statement> = [
                ...(plan.writes === undefined ? [] : [...flush(), ...plan.writes]),
                Effect.map(control(ending), (result) => {
                  tag = result.command

                  if (!chained) open = false
                }),
                Effect.map(connection.query(COMMIT_VERSION, [], true), (result) => {
                  version = (result.rows[0] as { version: string }).version
                }),
              ]

              locate(batch, following)

              const upcoming = chained
                ? yield* queue(following, after, commit)
                : { admission: undefined, flight: yield* queueStatements({ scope, group: commit }) }

              const answered = awaitReplies(upcoming.flight.slice(0, commit.length))

              yield* ending === "COMMIT"
                ? answered.pipe(Effect.withSpan(SpanNames.commit))
                : answered

              return {
                plan,
                version,
                ending,
                tag,
                following,
                chained:
                  upcoming.admission === undefined
                    ? undefined
                    : {
                        admission: upcoming.admission,
                        admitted: upcoming.flight.slice(commit.length),
                      },
              }
            }).pipe(inTurn, bounded)

            if (stepped.ending === "COMMIT" && stepped.tag !== "COMMIT")
              return yield* Effect.die(RetryTurn.make({ message: "Turn commit rolled back" }))

            return stepped
          })

        return yield* drive(
          (batch) =>
            queue(batch, view(), []).pipe(
              inTurn,
              Effect.map(({ admission, flight }): Admitting => ({ admission, admitted: flight })),
            ),
          transact,
        ).pipe(
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit) || !open) return Effect.void

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

        const rows = yield* sql.unsafe<{ version: string }>(COMMIT_VERSION)

        return { plan, version: rows[0]!.version }
      }),
  )

  const turns = yield* Effect.serviceOption(TurnConnections)

  const exit = yield* (Option.isSome(turns) ? pipelined(turns.value) : sequential).pipe(
    Effect.onError(() =>
      Effect.sync(() => {
        cache.state = undefined
      }),
    ),
    Effect.exit,
  )

  if (Exit.isSuccess(exit)) return undefined

  if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause)

  return { batch: current, orphan, cause: exit.cause, committed: answering } satisfies Stopped<W>
})
