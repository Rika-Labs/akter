import type { PgConnection } from "@effect/sql-pg"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Data,
  Layer,
  Option,
  Predicate,
  Scope,
} from "effect"
import type { SqlError } from "effect/sql"
import { COMMIT_VERSION } from "../database/replica.ts"
import { Metrics, record } from "../telemetry/metrics.ts"
import { queueStatements, type Send, TurnConnections } from "./pipeline.ts"

type Statement = Effect.Effect<void, SqlError.SqlError>

type Replies = ReadonlyArray<Fiber.Fiber<void, SqlError.SqlError>>

/**
 * How a member's turn ended in its group: committed with the group, at the
 * version and clock read after the group's transaction ended, or to be run
 * again in a transaction of its own because the group ended without it.
 */
export type Shared = Data.TaggedEnum<{
  Committed: {
    readonly version: string
    readonly endedAtMs: number
    /** The replies of the chained admission when the member took the group's session. */
    readonly chained: Replies | undefined
  }
  Alone: {}
}>

export const Shared = Data.taggedEnum<Shared>()

/**
 * A member whose actor already has its next batch waiting asks to take the
 * group's session after the commit, with that batch's `BEGIN` and admission
 * sent right behind the group's `COMMIT`. `adopt` receives the session and
 * the scope that returns it to the pool, and answers false when the member
 * can no longer take it, so the group discards the session instead.
 */
export interface Handoff {
  readonly chain: (connection: PgConnection.PgConnection) => ReadonlyArray<Statement>
  readonly adopt: (
    connection: PgConnection.PgConnection,
    scope: Scope.Closeable,
  ) => Effect.Effect<boolean>
}

const alone = Shared.Alone()

/**
 * Raised by a member's connection when the member sends a statement outside
 * its admission and its writes. The member leaves its group and runs again
 * alone, so nothing it sends while its handlers run can commit with others.
 */
export class Unseated extends Data.TaggedError("Unseated")<{}> {}

/** Postgres refused the statement only because an earlier one aborted the transaction. */
export const abortedBefore = (error: SqlError.SqlError) =>
  (error.reason.cause as { readonly code?: unknown } | undefined)?.code === "25P02"

export const errorOf = (
  exit: Exit.Exit<unknown, SqlError.SqlError>,
): SqlError.SqlError | undefined =>
  Exit.isSuccess(exit) ? undefined : Option.getOrUndefined(Cause.findErrorOption(exit.cause))

/** Members a group holds at most, which also bounds its commit flight. */
export const GROUP_MEMBERS = 32

/**
 * How long a closed group waits for members still running before it commits
 * without them. Tests change it to place an eviction or an interruption.
 */
export const TurnGroupSettings = Context.Reference<{ readonly wait: Duration.Duration }>(
  "akter/TurnGroupSettings",
  { defaultValue: () => ({ wait: Duration.millis(100) }) },
)

interface Seat {
  phase: "admitting" | "handling" | "deposited" | "committing" | "left" | "ended"
  admission: ReadonlyArray<Statement>
  sent: boolean
  readonly queued: Deferred.Deferred<Replies, SqlError.SqlError>
  writes: ReadonlyArray<Statement>
  handoff: Handoff | undefined
  interrupted: boolean
  readonly result: Deferred.Deferred<Shared, SqlError.SqlError>
}

interface Group {
  readonly key: string
  readonly seats: Array<Seat>
  readonly settings: (connection: PgConnection.PgConnection) => Statement
  readonly cancel: (connection: PgConnection.PgConnection) => Effect.Effect<void>
  connection: PgConnection.PgConnection | undefined
  scope: Scope.Closeable | undefined
  open: boolean
  begun: boolean
  sent: boolean
  done: boolean
  cancelled: boolean
  aborted: boolean
  closedAtMs: number
  signal: Deferred.Deferred<void>
}

/** One member's view of its group. */
export interface Member {
  /** The group's session, once the member's admission is queued. */
  readonly connection: () => PgConnection.PgConnection
  /** The replies of the member's admission statements, in order. */
  readonly replies: () => Replies
  /** From here the member's handlers run and its connection refuses statements; false once evicted. */
  readonly handling: Effect.Effect<boolean>
  /** Passes a statement only while the member admits or the group sends its writes. */
  readonly send: Send
  /**
   * Hands the member's commit writes to the group and waits for the shared
   * commit. Interrupted before the group sends them, the writes are withdrawn.
   */
  readonly commit: (
    writes: ReadonlyArray<Statement>,
    handoff?: Handoff,
  ) => Effect.Effect<Shared, SqlError.SqlError>
  /** Leaves without writes; `aborted` says one of the member's statements failed. */
  readonly leave: (aborted: boolean) => Effect.Effect<void>
}

/**
 * Concurrent warm turns of different actors sharing one transaction, one
 * `COMMIT` and one WAL flush. Each group leases one turn session and admits
 * members that would set the same transaction settings, until its first
 * member hands over its writes, every member has left, or it is full. Every member sends
 * its own admission on the group's session and waits for its own replies;
 * the first ones ride with `BEGIN` and the settings. Once every member has
 * handed over or left, or the wait after closing runs out and the members
 * still running are sent to run alone, one flight carries every member's
 * writes, `COMMIT` and the version and clock read.
 *
 * A warm admission writes nothing, so a member that leaves takes nothing with
 * it and its neighbours commit unaffected. A statement error aborts the whole
 * transaction: the member whose own statement failed gets its error, and every
 * other member runs again alone. A lost reply after the writes were sent is a
 * commit-unknown outcome for every member that handed over writes, and each
 * resolves through its receipt. A member's interruption cancels the group's
 * backend only once every member waiting on the sent commit was interrupted,
 * as a lone turn's would; the group's own interruption discards the session. The
 * session returns to the pool once nothing is in flight, before any member
 * publishes.
 */
export class TurnGroups extends Context.Service<
  TurnGroups,
  {
    readonly join: (options: {
      readonly key: string
      readonly settings: (connection: PgConnection.PgConnection) => Statement
      /** Cancels the statement the session's backend is running. */
      readonly cancel: (connection: PgConnection.PgConnection) => Effect.Effect<void>
      readonly admission: (member: Member) => ReadonlyArray<Statement>
    }) => Effect.Effect<Member, SqlError.SqlError>
  }
>()("@rikalabs/akter/runtime/turn/group/TurnGroups") {}

export const turnGroups = Layer.effect(
  TurnGroups,
  Effect.gen(function* () {
    const turns = yield* TurnConnections
    const { wait } = yield* TurnGroupSettings
    const layer = yield* Effect.scope
    const waitMs = Duration.toMillis(wait)
    const forming = new Map<string, Group>()

    const wake = (group: Group) => {
      Deferred.doneUnsafe(group.signal, Effect.void)
    }

    const close = (group: Group) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        if (!group.open) return

        group.open = false
        group.closedAtMs = now

        if (forming.get(group.key) === group) forming.delete(group.key)
      })

    const leave = (group: Group, seat: Seat, aborted: boolean) =>
      Effect.suspend(() => {
        if (seat.phase === "left" || seat.phase === "committing" || seat.phase === "ended")
          return Effect.void

        seat.phase = "left"
        seat.writes = []

        if (aborted) group.aborted = true

        return Effect.andThen(
          group.seats.every(({ phase }) => phase === "left") ? close(group) : Effect.void,
          Effect.sync(() => wake(group)),
        )
      })

    const queue = (group: Group, seat: Seat) =>
      Effect.suspend(() => {
        if (seat.sent || seat.phase !== "admitting") return Effect.void

        seat.sent = true

        return Effect.flatMap(
          queueStatements({ scope: group.scope!, group: seat.admission }),
          (replies) => Deferred.succeed(seat.queued, replies),
        )
      })

    /** Waits for the group's next change, at most `ms` when given; true when it changed. */
    const changed = (group: Group, ms?: number) =>
      Effect.suspend(() => {
        const signal = group.signal
        const waiting = Deferred.await(signal)

        return Effect.map(
          ms === undefined ? waiting : Effect.timeoutOption(waiting, Duration.millis(ms)),
          () => {
            const fired = Deferred.isDoneUnsafe(signal)

            if (fired) group.signal = Deferred.makeUnsafe<void>()

            return fired
          },
        )
      })

    const settled = (group: Group) =>
      group.seats.every(({ phase }) => phase === "deposited" || phase === "left")

    /**
     * Ends the group's transaction, then returns or hands over the session,
     * and only then answers every member that handed over writes, so no
     * member publishes while the session is still out. A member whose turn
     * ended moves to a terminal phase, so its connection refuses any later
     * statement. The hand-off goes only to a member still waiting; an
     * interrupted one's session is discarded with its chained transaction.
     */
    const commit = Effect.fnUntraced(function* (group: Group) {
      group.sent = true

      const members = group.seats.filter(({ phase }) => phase === "deposited")

      for (const seat of members) seat.phase = "committing"

      const writes = group.aborted ? [] : members.flatMap(({ writes }) => writes)
      const ending = writes.length > 0 ? "COMMIT" : "ROLLBACK"
      const connection = group.connection!
      const held = group.scope!
      const handoff = group.aborted ? undefined : members.find((seat) => seat.handoff !== undefined)
      let tag: string | undefined
      let version = ""
      let endedAtMs = 0

      const replies = yield* queueStatements({
        scope: held,
        group: [
          ...writes,
          Effect.map(connection.query(ending, [], true), (result) => {
            tag = result.command
          }),
          Effect.map(connection.query(COMMIT_VERSION, [], true), (result) => {
            const ended = result.rows[0] as { version: string; now: string }
            version = ended.version
            endedAtMs = Number(ended.now)
          }),
          ...(handoff === undefined ? [] : handoff.handoff!.chain(connection)),
        ],
      })

      const chained = replies.slice(writes.length + 2)
      const exits = yield* Effect.forEach(replies.slice(0, writes.length + 2), Fiber.await)
      group.done = true

      const errors = exits.map(errorOf)
      const lost = errors.find(
        (error) => error !== undefined && Predicate.isTagged(error.reason, "ConnectionError"),
      )
      const ended = exits[writes.length]!
      const read = errors[writes.length + 1]
      const committed = Exit.isSuccess(ended) && tag === "COMMIT"
      const outcomes: Array<readonly [Seat, Exit.Exit<Shared, SqlError.SqlError>]> = []
      let offset = 0

      for (const seat of members) {
        const own = group.aborted ? [] : errors.slice(offset, offset + seat.writes.length)
        offset += own.length

        if (lost !== undefined) {
          outcomes.push([seat, Exit.fail(lost)])
          continue
        }

        if (seat.writes.length === 0 ? !Exit.isSuccess(ended) : !committed) {
          const error = own.find((failure) => failure !== undefined && !abortedBefore(failure))
          outcomes.push([seat, error === undefined ? Exit.succeed(alone) : Exit.fail(error)])
          continue
        }

        const unknown = own.find((failure) => failure !== undefined) ?? read
        outcomes.push([
          seat,
          unknown === undefined
            ? Exit.succeed(Shared.Committed({ version, endedAtMs, chained: undefined }))
            : Exit.fail(unknown),
        ])
      }

      const taking = outcomes.some(
        ([seat, outcome]) =>
          seat === handoff &&
          !seat.interrupted &&
          !group.cancelled &&
          lost === undefined &&
          Exit.isSuccess(outcome) &&
          Shared.$is("Committed")(outcome.value),
      )
      const handed = taking && (yield* handoff!.handoff!.adopt(connection, held))

      if (lost !== undefined || group.cancelled || (handoff !== undefined && !handed))
        yield* turns.invalidate(connection)

      if (!handed) yield* Scope.close(held, Exit.void)

      for (const [seat, outcome] of outcomes) {
        seat.phase = "ended"

        yield* Deferred.done(
          seat.result,
          handed &&
            seat === handoff &&
            Exit.isSuccess(outcome) &&
            Shared.$is("Committed")(outcome.value)
            ? Exit.succeed(Shared.Committed({ ...outcome.value, chained }))
            : outcome,
        )
      }
    })

    /**
     * One group from lease to commit. A lease that fails, a refusal included,
     * fails every member before anything of theirs was sent. An interrupted
     * group discards its session, so an unsent `COMMIT` rolls back with it.
     */
    const drive = Effect.fnUntraced(function* (group: Group) {
      const held = yield* Scope.make()
      const leasing = yield* Clock.currentTimeMillis
      const leased = yield* Scope.provide(turns.lease, held).pipe(Effect.exit)

      if (Exit.isFailure(leased)) {
        yield* close(group)
        yield* Scope.close(held, leased)
        const error = errorOf(leased)

        for (const seat of group.seats) {
          yield* Deferred.failCause(
            seat.queued,
            error === undefined ? Cause.die(Cause.squash(leased.cause)) : Cause.fail(error),
          )
        }

        return
      }

      yield* record(Metrics.poolWait, {}, (yield* Clock.currentTimeMillis) - leasing)

      group.connection = leased.value
      group.scope = held

      yield* Effect.gen(function* () {
        while (!group.seats.some(({ phase }) => phase === "admitting") && group.open)
          yield* changed(group)

        if (!group.seats.some(({ phase }) => phase === "admitting")) {
          yield* close(group)
          return yield* Scope.close(held, Exit.void)
        }

        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* queueStatements({
              scope: held,
              group: [
                Effect.asVoid(leased.value.query("BEGIN", [], true)),
                group.settings(leased.value),
              ],
            })

            group.begun = true

            for (const seat of group.seats) yield* queue(group, seat)
          }),
        )

        while (group.open || !settled(group)) {
          if (group.open) {
            yield* changed(group)
            continue
          }

          const left = waitMs - ((yield* Clock.currentTimeMillis) - group.closedAtMs)

          if (left <= 0 || !(yield* changed(group, left))) {
            for (const seat of group.seats)
              if (seat.phase === "admitting" || seat.phase === "handling") {
                seat.phase = "ended"
                yield* Deferred.succeed(seat.result, alone)
              }

            break
          }
        }

        yield* Effect.uninterruptible(commit(group))
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            group.sent = true
            yield* close(group)

            if (group.begun) yield* turns.invalidate(leased.value)

            yield* Scope.close(held, Exit.void)

            for (const seat of group.seats) {
              yield* Deferred.interrupt(seat.queued)
              yield* Deferred.interrupt(seat.result)
            }
          }),
        ),
      )
    })

    const join = (options: {
      readonly key: string
      readonly settings: (connection: PgConnection.PgConnection) => Statement
      readonly cancel: (connection: PgConnection.PgConnection) => Effect.Effect<void>
      readonly admission: (member: Member) => ReadonlyArray<Statement>
    }) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const found = forming.get(options.key)
          const group: Group = found ?? {
            key: options.key,
            seats: [],
            settings: options.settings,
            cancel: options.cancel,
            connection: undefined,
            scope: undefined,
            open: true,
            begun: false,
            sent: false,
            done: false,
            cancelled: false,
            aborted: false,
            closedAtMs: 0,
            signal: Deferred.makeUnsafe<void>(),
          }

          if (found === undefined) forming.set(options.key, group)

          const seat: Seat = {
            phase: "admitting",
            admission: [],
            sent: false,
            queued: Deferred.makeUnsafe<Replies, SqlError.SqlError>(),
            writes: [],
            handoff: undefined,
            interrupted: false,
            result: Deferred.makeUnsafe<Shared, SqlError.SqlError>(),
          }

          let replies: Replies = []

          const member: Member = {
            connection: () => group.connection!,
            replies: () => replies,
            handling: Effect.sync(() => {
              if (seat.phase !== "admitting") return false

              seat.phase = "handling"

              return true
            }),
            send: (statement) =>
              Effect.suspend(() =>
                seat.phase === "admitting" || seat.phase === "committing"
                  ? statement
                  : Effect.die(new Unseated()),
              ),
            commit: (writes, handoff) =>
              Effect.suspend(() => {
                if (seat.phase !== "handling") return Effect.succeed(alone)

                seat.phase = "deposited"
                seat.writes = writes
                seat.handoff = handoff

                return close(group).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      wake(group)
                    }),
                  ),
                  Effect.andThen(restore(Deferred.await(seat.result))),
                  Effect.onInterrupt(() =>
                    Effect.suspend(() => {
                      if (!group.sent) return leave(group, seat, false)

                      seat.interrupted = true

                      if (
                        group.done ||
                        group.cancelled ||
                        group.seats.some((each) => each.phase === "committing" && !each.interrupted)
                      )
                        return Effect.void

                      group.cancelled = true

                      return group.cancel(group.connection!)
                    }),
                  ),
                )
              }),
            leave: (aborted) => leave(group, seat, aborted),
          }

          seat.admission = options.admission(member)
          group.seats.push(seat)

          const full = group.seats.length >= GROUP_MEMBERS ? close(group) : Effect.void

          const start =
            found === undefined
              ? Effect.asVoid(Effect.forkIn(drive(group), layer))
              : group.begun
                ? queue(group, seat)
                : Effect.sync(() => wake(group))

          return full.pipe(
            Effect.andThen(start),
            Effect.andThen(restore(Deferred.await(seat.queued))),
            Effect.map((queued) => {
              replies = queued

              return member
            }),
            Effect.onInterrupt(() => leave(group, seat, false)),
          )
        }),
      )

    return TurnGroups.of({ join })
  }),
)
