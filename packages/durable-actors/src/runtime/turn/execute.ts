import { Effect, Exit, Option, Result, Schema } from "effect"
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
import { eventsStatement, notifyEvents } from "../events/append.ts"
import { compress, decompress } from "../storage/codec.ts"
import { receiptMarginMs } from "../storage/retention.ts"
import { FrameworkClock } from "./admission.ts"
import { RetryTurn, TurnHooks } from "./hooks.ts"
import { CallerJson, OutboxRuntime, type OutboxReplies, outboxStatements } from "./outbox.ts"
import {
  asSqlConnection,
  isInterrupted,
  pipeline,
  type Send,
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
  readonly emitted: ReadonlyArray<{ readonly emittedAtMs: number }>
  readonly outbox: ReadonlyArray<OutboxReplies>
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
 *
 * `statements` marks an actor whose handler can issue SQL; only its handlers
 * run under a savepoint, so a declared failure discards the handler's rows.
 * Every command id in a batch must be distinct.
 */
export const executeBatch = Effect.fnUntraced(function* (
  deliveries: ReadonlyArray<Delivery>,
  cache: ActivationCache,
  routingKey: bigint,
  policy: TurnPolicy,
  mintable: boolean,
  statements: boolean,
  waited: ReadonlySet<string> = new Set(),
  connections?: ConnectionLister,
) {
  const sql = yield* SqlClient.SqlClient
  const hooks = yield* TurnHooks
  const clock = yield* FrameworkClock
  const { tenant, actor, id } = deliveries[0]!.request.ref

  const actorRow = sql`routing_key = ${routingKey} AND tenant_id = ${tenant} AND actor_type = ${actor} AND actor_id = ${id}`

  const turn = Effect.fnUntraced(function* (session: Session, begin: ReadonlyArray<Statement>) {
    const cold = cache.generation === undefined

    const timeouts = sql`set_config('lock_timeout', ${`${policy.lockWaitMs}ms`}, true),
      set_config('statement_timeout', ${`${policy.executionMs}ms`}, true)`

    const readsState = cold || cache.state === undefined
    let admissions: ReadonlyArray<Admission> = []
    let bumped: string | undefined
    let stored: ReadonlyArray<{ key: string; value: Uint8Array }> = []

    const commands = sql.csv(
      deliveries.map(
        ({ request }, index) =>
          sql`(${index}::integer, ${request.commandId}::text, ${request.payload}::text)`,
      ),
    )

    // None of these takes a parameter from another's reply. The insert comes
    // before the fenced read, so a brand-new actor's receipts are resolved
    // under the generation row lock too.
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
            c.payload::jsonb::text AS canonical,
            r.caller_key, r.command, r.payload_hash, r.outcome, g.event_sequence::text AS head
          FROM actor_generations g
          CROSS JOIN (VALUES ${commands}) AS c (ordinal, command_id, payload)
          LEFT JOIN actor_receipts r ON r.routing_key = g.routing_key AND r.tenant_id = g.tenant_id
            AND r.actor_type = g.actor_type AND r.actor_id = g.actor_id AND r.command_id = c.command_id
          WHERE g.routing_key = ${routingKey} AND g.tenant_id = ${tenant}
            AND g.actor_type = ${actor} AND g.actor_id = ${id}
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
    ])

    const first = admissions[0]

    // Another runner advanced the generation since this activation acquired
    // it, so its cached state may be stale. Nothing runs or is written; the
    // activation drops its cache and the retry reloads under a new generation.
    if (first === undefined || (!cold && cache.generation !== first.generation)) {
      cache.generation = undefined
      cache.state = undefined

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

    const settled: Array<Settled> = []
    // State after every handler so far, loaded only once a handler runs.
    let next: Map<string, string> | undefined
    const dirty = new Map<string, string>()
    const removed = new Set<string>()
    // Each command's events and outbox rows, in delivery order.
    const staged: Array<Statement> = []
    const receipts: Array<ReceiptRow> = []
    let created = first.created
    let creates = false
    let replayed = false
    let wake = false
    // Broadcasts of committed successes, and how many events the batch appends.
    const broadcasts: Array<Broadcast> = []
    let events = 0
    const committed: Array<Omit<CommittedEvents, "emittedAtMs">> = []
    const emitted: Array<{ readonly emittedAtMs: number }> = []
    const outboxes: Array<OutboxReplies> = []

    for (const [index, { request, command }] of deliveries.entries()) {
      const admitted = admissions[index]!
      const hash = yield* hashCanonical(admitted.canonical)

      if (admitted.outcome !== null) {
        const replay = yield* checkReceipt(request, hash, admitted as StoredReceipt).pipe(
          Effect.result,
        )

        replayed ||= Result.isSuccess(replay)
        settled.push(replay)
        continue
      }

      // Admitted work still runs past expiry, but not once cleanup may have
      // pruned a receipt of this id that committed meanwhile: without it, an
      // expired external id would run again.
      if (
        request.external === true &&
        now >= commandTimes(request.commandId).expiresAt + expiryMarginMs
      ) {
        settled.push(
          Result.fail(
            ActorError.make({ reason: CommandExpired.make({ commandId: request.commandId }) }),
          ),
        )
        continue
      }

      if (command.internal && !isSystem(request.caller))
        return yield* Effect.die(new Error("Internal commands require a System caller"))

      if (policy.createdBy !== undefined && !created && policy.createdBy !== request.command) {
        settled.push(Result.fail(ActorError.make({ reason: NotCreated.make({}) })))
        continue
      }

      // A minted actor is created only by the relay delivering the creating
      // intent its parent's turn staged and committed: the proof binds the id to
      // the parent's command, and the parent's outbox row, which stays until its
      // delivery commits, proves that command committed the intent.
      if (
        mintable &&
        policy.createdBy === request.command &&
        !created &&
        isMintedId(id) &&
        (request.external === true || !(yield* committedMintIntent(request)))
      ) {
        settled.push(
          Result.fail(ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) })),
        )
        continue
      }

      next ??= readsState
        ? new Map(stored.map(({ key, value }) => [key, decompress(value)] as const))
        : new Map(cache.state!)

      const given = next

      // The first handler's savepoint went out with admission; each later
      // one's goes out with that handler's first statement, if it has one.
      const savepoint = `SAVEPOINT ${HANDLER_SAVEPOINT}`

      if (statements && index > 0) yield* session.defer(savepoint)

      const business = yield* Effect.gen(function* () {
        yield* hooks.at("beforeHandler", request)

        return yield* command.run(request, [...given], connections)
      }).pipe(Effect.catchIf(SqlError.isSqlError, Effect.die), Effect.result)

      const result: BusinessResult = Result.isSuccess(business)
        ? business.success
        : business.failure

      // A handler that issued no statement has nothing to roll back, so its
      // unsent savepoint is dropped. Rolling back to a savepoint keeps it, so
      // each failed handler leaves one open until commit: a batch never holds
      // more savepoints than its cap of commands.
      if (statements && (index === 0 || !session.withdraw(savepoint)))
        yield* session.defer(
          Result.isSuccess(business)
            ? `RELEASE SAVEPOINT ${HANDLER_SAVEPOINT}`
            : `ROLLBACK TO SAVEPOINT ${HANDLER_SAVEPOINT}`,
        )

      const written = new Map(result.state)

      // A complete result lists every key it keeps; any other key it was
      // given is deleted.
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
          after: String(BigInt(first.head) + BigInt(events)),
          events: result.events,
          commandId: request.commandId,
        })
        emitted.push(appended.stamp)
      }

      events += result.events.length

      if (Outcome.guards.Success(result.outcome)) broadcasts.push(...(result.broadcasts ?? []))

      // Re-arming waiting workflows reads their steps, so it runs before the
      // commit group; only an actor with a workflow waiting on an emitted class
      // pays for it.
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

      receipts.push({
        routing_key: routingKey,
        tenant_id: tenant,
        actor_type: actor,
        actor_id: id,
        command_id: request.commandId,
        command: request.command,
        payload_hash: hash,
        caller_key: callerKey(request.caller),
        outcome: yield* encodeOutcome(result.outcome).pipe(Effect.orDie),
        expires_at_ms: commandTimes(request.commandId).expiresAt,
      })
      yield* hooks.at("beforeCommit", request)
      settled.push(Result.succeed(result.outcome))
    }

    // Nothing ran and nothing replays on a newly acquired generation, so
    // there is nothing worth committing. A cold activation that replays keeps
    // the generation it acquired, so work the replay wakes runs under it.
    if (receipts.length === 0 && !(cold && replayed))
      return {
        writes: undefined,
        settled,
        generation: current,
        state: cache.state,
        wake: false,
        broadcasts: [],
        head: first.head,
        committed: [],
        emitted: [],
        outbox: [],
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
      writes.push(Effect.asVoid(sql`UPDATE actor_generations SET created = true WHERE ${actorRow}`))

    if (receipts.length > 0)
      writes.push(Effect.asVoid(sql`INSERT INTO actor_receipts ${sql.insert(receipts)}`))

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
    } satisfies Plan
  })

  const turns = yield* Effect.serviceOption(TurnConnections)

  const transaction = Option.isSome(turns)
    ? pipelined(turns.value, turn)
    : sql
        .withTransaction(
          Effect.gen(function* () {
            const control = (text: string) => Effect.asVoid(sql.unsafe(text))

            const plan = yield* turn(
              { send: sequential, control, defer: control, withdraw: () => false },
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

  // A rolled-back batch changed nothing, so the cache stays as it was.
  if (done.writes !== undefined) {
    cache.generation = done.generation
    cache.state = done.state
  }

  if (done.wake || done.outbox.some((replies) => replies.wake)) yield* (yield* OutboxRuntime).wake

  if (done.outbox.some((replies) => replies.cancelled)) yield* (yield* OutboxRuntime).cancelled

  return {
    settled: done.settled,
    broadcasts: done.broadcasts,
    head: done.head,
    committed: done.committed.map((entry, index): CommittedEvents => ({
      ...entry,
      emittedAtMs: done.emitted[index]!.emittedAtMs,
    })),
  }
})

/**
 * Runs a batch on a leased Postgres session: the admission group opens with
 * `BEGIN`, and the commit group ends with `COMMIT`, whose command tag must be
 * `COMMIT`, since Postgres answers `COMMIT` in an aborted transaction with
 * `ROLLBACK`. Any other exit rolls back, and a session whose transaction state
 * is unknown never goes back to the pool: an interrupted batch cancels its
 * backend's statement and discards the session, so an unsent `COMMIT` rolls
 * back with it and one already sent resolves through the receipt on retry.
 *
 * Deferred statements go out in the same flight as the next statement a
 * handler sends, or at the head of the commit group.
 */
const pipelined = <E, R>(
  turns: TurnConnections["Service"],
  turn: (session: Session, begin: ReadonlyArray<Statement>) => Effect.Effect<Plan, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const connection = yield* turns.lease
      let open = false
      const deferred: Array<string> = []

      const control = (text: string) => connection.query(text, [], true)

      const end = (text: "COMMIT" | "ROLLBACK") =>
        Effect.map(control(text), (result) => {
          open = false

          return result.command
        })

      const flush = () => deferred.splice(0).map((text) => Effect.asVoid(control(text)))

      const send: Send = <A>(statement: Effect.Effect<A, SqlError.SqlError>) =>
        Effect.suspend(() => {
          if (deferred.length === 0) return statement

          let reply: { readonly value: A } | undefined

          return pipeline([
            ...flush(),
            Effect.map(statement, (value) => {
              reply = { value }
            }),
          ]).pipe(Effect.map(() => reply!.value))
        })

      let tag: string | undefined

      const plan = yield* Effect.gen(function* () {
        // The session is unsafe from the moment BEGIN may be queued until a
        // transaction-ending reply confirms it is idle again.
        open = true
        const begin = Effect.asVoid(control("BEGIN"))

        const decided = yield* turn(
          {
            send: pipeline,
            control: (text) => Effect.asVoid(control(text)),
            defer: (text) =>
              Effect.sync(() => {
                deferred.push(text)
              }),
            withdraw: (text) => deferred.at(-1) === text && deferred.pop() !== undefined,
          },
          [begin],
        )

        const ending = decided.writes === undefined ? "ROLLBACK" : "COMMIT"

        yield* pipeline([
          ...(decided.writes === undefined ? [] : [...flush(), ...decided.writes]),
          Effect.map(end(ending), (command) => {
            tag = command
          }),
        ])

        if (ending === "COMMIT" && tag !== "COMMIT")
          return yield* Effect.die(RetryTurn.make({ message: "Turn commit rolled back" }))

        return decided
      }).pipe(
        Effect.provideService(sql.transactionService, [asSqlConnection({ connection, send }), 0]),
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
