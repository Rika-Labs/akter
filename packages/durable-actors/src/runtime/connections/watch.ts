import {
  Clock,
  Context,
  Deferred,
  Effect,
  Match,
  Option,
  Predicate,
  Queue,
  Result,
  Schema,
  Stream,
} from "effect"
import { ActorError, InvalidInput, SessionEnded } from "../../errors/actor.ts"
import { Outcome, type Request, type WatchResult } from "../../handles/actors.ts"
import type { Holder, HeldConnection } from "./holder.ts"
import { Committed, watchMember } from "./protocol.ts"
import { emptyReadSet, invalidates, type ReadSet, unsupportedRead } from "./reads.ts"

/**
 * Asked before an owner broadcasts a commit's `Committed` frame; `true` drops
 * it, as a lost best-effort broadcast would. Tests drop frames here to show
 * the reconcile rerun recovers them.
 */
export const WatchTap = Context.Reference<{ readonly dropsCommitted: () => boolean }>(
  "@durable-actors/core/runtime/connections/watch/WatchTap",
  { defaultValue: () => ({ dropsCommitted: () => false }) },
)

/** How long a watch waits before it reruns after a rerun failed for a reason a later attempt may not share. */
const RERUN_RETRY_MS = 1_000

const decodeCommitted = Schema.decodeEffect(Schema.fromJsonString(Committed))

/** Ends that a watch survives by reopening at its holder and rerunning, as a feed does. */
const recoverable = (error: ActorError) =>
  Predicate.isTagged(error.reason, "SessionEnded") &&
  ["SlowConsumer", "OwnerLost", "ActorUnavailable"].includes(error.reason.cause)

/** Failures of a rerun that the next attempt may not repeat. */
const transient = (error: ActorError) =>
  Predicate.isTagged(error.reason, "ActorUnavailable") ||
  Predicate.isTagged(error.reason, "Timeout") ||
  Predicate.isTagged(error.reason, "RunnerAtCapacity")

/** What a watch needs from its runner: the holder its connection parks at, and one rerun of the query. */
export interface WatchOptions {
  readonly holder: Holder
  /** The request to watch: `command` is the query and `payload` its encoded input. */
  readonly request: Request
  readonly minIntervalMs: number
  readonly reconcileMs: number
  /** A commit version the first result must reflect at least. */
  readonly minVersion: string | undefined
  /** The credential's own expiry in epoch milliseconds, if it has one. */
  readonly expiresAt: number | undefined
  /**
   * Reruns the query for this watch and records what it read. `version` is
   * called once the rerun holds its place among the runner's reruns, so a rerun
   * that waited for one starts from the newest version seen meanwhile.
   */
  readonly rerun: (
    version: () => string | undefined,
    reads: ReadSet,
  ) => Effect.Effect<Outcome, ActorError>
}

/**
 * A watch on one query: its current result first, then the newest result after
 * each commit whose writes intersect what the last run read. The watch is a
 * parked framework connection, so the owner sends it one `Committed` frame per
 * commit and nothing keeps the actor resident.
 *
 * Reruns are coalesced: at most one runs and one waits, frames that arrive
 * meanwhile only raise the version the next rerun waits for, and reruns of one
 * watch start at least `minIntervalMs` apart. A result equal to the last one
 * sent is not sent, and the newest result replaces one nobody has read yet, so
 * a slow reader never ends the watch. The broadcast is best-effort, so the
 * watch also reruns every `reconcileMs`, after a holder resync, and after a
 * reopen, which is how a lost frame or a change no commit reports is shown.
 * A rerun that reads what a commit signal cannot cover ends the watch with
 * `not_watchable`, and one that fails transiently is retried. A result read
 * for a session past its authorization bound is dropped.
 */
export const watchStream = Effect.fnUntraced(function* (options: WatchOptions) {
  const { holder, request } = options

  const open = holder
    .open({
      ref: request.ref,
      member: watchMember(request.command),
      caller: request.caller,
      params: "",
      expiresAt: options.expiresAt,
    })
    .pipe(
      Effect.catchTag("OpenRejected", () => Effect.die(new Error("A watch has no open handler"))),
    )

  const first = yield* open

  return Stream.callback<WatchResult, ActorError | { readonly failure: string }>(
    (out) =>
      Effect.gen(function* () {
        let held: HeldConnection = first
        let pending = options.minVersion === undefined ? undefined : BigInt(options.minVersion)
        let reads: ReadSet | undefined
        let dirty = true
        let sent: string | undefined
        let settling: Array<Deferred.Deferred<void>> = []
        const signal = yield* Queue.sliding<void>(1)

        yield* Effect.addFinalizer(() => held.close)

        const raise = () => {
          dirty = true
          Queue.offerUnsafe(signal, undefined)
        }

        const note = (committed: Committed) => {
          const version = BigInt(committed.version)

          if (pending === undefined || version > pending) pending = version

          if (reads === undefined || invalidates(committed.writes, reads)) raise()
        }

        const listen = (connection: HeldConnection) =>
          connection.messages.pipe(
            Stream.runForEach((item) =>
              Match.value(item).pipe(
                Match.tagsExhaustive({
                  Frame: (frame) =>
                    decodeCommitted(frame.frame).pipe(Effect.orDie, Effect.map(note)),
                  Resync: () => Effect.void,
                  ResyncReplayed: () =>
                    Effect.gen(function* () {
                      const done = yield* Deferred.make<void>()
                      settling.push(done)
                      raise()
                      yield* Deferred.await(done)
                      yield* connection.resyncDone
                    }),
                  Progress: () => Effect.void,
                }),
              ),
            ),
          )

        const follow = Effect.gen(function* () {
          while (true) {
            const ended = yield* listen(held).pipe(Effect.flip, Effect.option)

            if (Option.isNone(ended)) return

            if (!recoverable(ended.value)) return yield* ended.value

            held = yield* open
            raise()
          }
        })

        const refuse = (reason: string) =>
          ActorError.make({
            reason: InvalidInput.make({
              code: "not_watchable",
              issues: [{ path: request.command, message: reason }],
            }),
          })

        const rerun = Effect.gen(function* () {
          const read = emptyReadSet()
          let version: string | undefined

          const outcome = yield* options
            .rerun(() => (version = pending?.toString()), read)
            .pipe(Effect.result)

          if (Result.isFailure(outcome)) {
            if (!transient(outcome.failure)) return yield* outcome.failure
            raise()
            yield* Effect.sleep(RERUN_RETRY_MS)

            return
          }

          const result = outcome.success

          if (Outcome.guards.Failure(result)) return yield* Effect.fail({ failure: result.value })

          if (Outcome.guards.Defect(result)) {
            yield* Effect.logError("Watch handler defect", result.cause)

            return yield* ActorError.make({
              reason: SessionEnded.make({ cause: "Defect", resync: false }),
            })
          }

          if (!Outcome.guards.Success(result))
            return yield* Effect.die(new Error("A query cannot acknowledge"))

          const unsupported = unsupportedRead(read)

          if (unsupported !== undefined) return yield* refuse(unsupported)

          reads = read

          if (result.value === sent || !(yield* held.authorized)) return

          sent = result.value
          yield* Queue.offer(out, { version, value: result.value })
        })

        const reruns = Effect.gen(function* () {
          let startedAt = Number.NEGATIVE_INFINITY

          while (true) {
            while (!dirty) {
              const woke = yield* Queue.take(signal).pipe(Effect.timeoutOption(options.reconcileMs))

              if (Option.isNone(woke)) dirty = true
            }

            const wait = startedAt + options.minIntervalMs - (yield* Clock.currentTimeMillis)

            if (wait > 0) yield* Effect.sleep(wait)
            startedAt = yield* Clock.currentTimeMillis
            dirty = false
            const covered = settling
            settling = []
            yield* rerun
            yield* Effect.forEach(covered, (done) => Deferred.succeed(done, undefined), {
              discard: true,
            })
          }
        })

        yield* Effect.all([follow, reruns], { concurrency: "unbounded", discard: true }).pipe(
          Effect.catch((error) =>
            Schema.is(ActorError)(error) && Predicate.isTagged(error.reason, "Unauthorized")
              ? Effect.andThen(Effect.ignore(Queue.clear(out)), Queue.fail(out, error))
              : Queue.fail(out, error),
          ),
          Effect.catchCause((cause) => Queue.failCause(out, cause)),
          Effect.forkScoped,
        )
      }),
    { bufferSize: 1, strategy: "sliding" },
  )
})
