import { Deferred, Duration, Effect, Match, Option, Schema } from "effect"
import {
  ActorError,
  CommandConflict,
  CommandExpired,
  Timeout,
  Unauthorized,
} from "../../errors/actor.ts"
import { retryDeadline } from "../clock.ts"
import { CREDENTIAL_CODES, type Failure } from "../transport.ts"
import { OfflineStoreError, type OfflineStore, type QueuedCommand } from "./store.ts"

/** A queued command as an application sees it. */
export interface PendingCommand {
  readonly commandId: string
  /** The actor's route under the client's `baseUrl`. */
  readonly target: string
  readonly member: string
  /** The JSON the command was called with, as sent. */
  readonly input: Schema.Json | undefined
  /**
   * `queued` is still being delivered; `held` was queued under another
   * principal and waits until that principal signs back in or the application
   * discards it; `expired` and `failed` wait for the application to `discard` them.
   */
  readonly status: QueuedCommand["status"] | "held"
  /**
   * While `queued`, the last answer that did not settle the command, such as a
   * network failure or a rejected credential. For `expired`, its
   * `CommandExpired`; for `failed`, the failure the server answered with.
   */
  readonly failure: Failure | undefined
}

/**
 * A client's persisted command queue. Every command is saved before its first
 * attempt and sent under the id it was saved with until the server answers or
 * the id expires; nothing here ever mints a replacement id.
 */
export interface OfflineQueue {
  /** Settles once saved commands are read; rejects with `OfflineStoreError` when the store cannot be read. */
  readonly ready: Promise<void>
  /** Every command not yet removed, in queue order. Empty until `ready`. */
  readonly pending: ReadonlyArray<PendingCommand>
  /** Calls `listener` with `pending` after each change; returns the unsubscribe. */
  readonly subscribe: (listener: (pending: ReadonlyArray<PendingCommand>) => void) => () => void
  /**
   * Tries again now: skips any wait between attempts and resumes an actor
   * whose commands stopped on a rejected credential. It also runs when the
   * browser reports it is back online.
   */
  readonly flush: () => void
  /**
   * Forgets a command and never sends it again; a command already sent may
   * have been applied. It settles a caller still waiting with `Timeout`.
   * The only way to resolve an `expired`, `failed`, or `held` command.
   */
  readonly discard: (commandId: string) => Promise<void>
  /** Stops delivering. Saved commands stay saved for the next session. */
  readonly close: () => void
}

/** What a client asks the queue to save; the queue adds its position, base URL, principal and status. */
type NewCommand = Pick<QueuedCommand, "commandId" | "target" | "member" | "body">

/** One answered attempt that did not settle the command, with when to try again if the client knows. */
export interface Refused {
  readonly failure: Failure
  readonly retryAfterMs: Option.Option<number>
  readonly answer: QueuedCommand["answer"]
}

export interface QueueOptions<Output> {
  readonly store: OfflineStore
  /** Only commands saved under this base URL are delivered. */
  readonly baseUrl: string
  /** Only commands of this actor type are delivered. */
  readonly actor: string
  /**
   * The principal the client runs as now, read before each command is saved
   * and before each attempt; only commands saved under it are sent.
   */
  readonly principal: Effect.Effect<string>
  /** The estimated database time, for judging a command's expiry. */
  readonly now: () => number
  /**
   * Starts one command's delivery and returns one attempt at it, which may be
   * run again. It succeeds with the decoded output or fails with why it did
   * not settle.
   */
  readonly begin: (command: QueuedCommand) => Effect.Effect<Output, Refused>
  /** The failure a saved `failed` command's answer decodes to. */
  readonly failureOf: (command: QueuedCommand) => Failure
  /** Learns the retry window and the database clock while the network is up, so commands can be minted offline. */
  readonly warm: Effect.Effect<void>
}

/** What the queue hands back for a saved command. */
export interface Delivery<Output> {
  /** Succeeds with the command's output once the server answers; fails with the terminal failure. */
  readonly settled: Effect.Effect<Output, Failure>
}

/** The queue a client drives: what an application sees, plus saving commands. */
interface CommandQueue<Output> extends OfflineQueue {
  /**
   * Saves the command `make` builds, then delivers it. Calls are taken one at
   * a time in the order they were made, so an id that takes longer to mint
   * still queues in front of a later call. Resolves to nothing when `signal`
   * aborted before the command was saved, in which case nothing was queued.
   * Rejects with `OfflineStoreError` when the command could not be saved, and
   * then nothing was sent.
   */
  readonly submit: (
    make: Effect.Effect<NewCommand, Failure>,
    signal: AbortSignal | undefined,
  ) => Promise<Delivery<Output> | undefined>
}

interface Slot<Output> {
  command: QueuedCommand
  failure: Failure | undefined
  discarded: boolean
  readonly settled: Deferred.Deferred<Output, Failure>
}

/** How long to wait before asking again after a retryable failure that names no delay. */
const IDLE_RETRY_MS = 5_000

const isFramework = Schema.is(ActorError)

const isExpired = (failure: Failure) =>
  isFramework(failure) && Schema.is(CommandExpired)(failure.reason)

const isCredentialFailure = (failure: Failure) =>
  isFramework(failure) &&
  Schema.is(Unauthorized)(failure.reason) &&
  CREDENTIAL_CODES.has(failure.reason.code)

const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const noop = () => undefined

const report = (error: OfflineStoreError) => Effect.sync(() => reportError(error))

const guard = <A>(operation: OfflineStoreError["operation"], work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (cause) => OfflineStoreError.make({ operation, cause }) })

const expiredFailure = (commandId: string) =>
  ActorError.make({ reason: CommandExpired.make({ commandId }) })

const viewOf =
  (principal: string | undefined) =>
  <Output>({ command, failure }: Slot<Output>): PendingCommand => ({
    commandId: command.commandId,
    target: command.target,
    member: command.member,
    input: command.body === undefined ? undefined : Option.getOrUndefined(decodeBody(command.body)),
    status:
      command.status === "queued" && command.principal !== principal ? "held" : command.status,
    failure,
  })

/**
 * The queue behind a client's `offline` option. It keeps each actor's commands
 * in the order they were called and sends one at a time, so a later command
 * never overtakes an earlier one that is still waiting for the network;
 * different actors are delivered independently. A command that expires or is
 * rejected for good does not hold back those after it.
 *
 * Each command is saved under the principal the client ran as, and only
 * commands of the current principal are sent: another's are `held`, so a
 * shared store never sends one user's commands with another's credential.
 *
 * Ids are minted by the caller and stored with the command, so a replay after
 * a lost reply, a reload, or a second tab is a retry the receipt answers, never
 * a second execution. Tabs sharing one store each deliver what they read, and
 * only the order within a tab is kept.
 */
export const openCommandQueue = <Output>(options: QueueOptions<Output>): CommandQueue<Output> => {
  const slots = new Map<string, Slot<Output>>()
  const listeners = new Set<(pending: ReadonlyArray<PendingCommand>) => void>()
  const wakers = new Set<() => void>()
  const draining = new Set<string>()
  const parked = new Set<string>()
  const loading = Deferred.makeUnsafe<void, OfflineStoreError>()
  let snapshot: ReadonlyArray<PendingCommand> = []
  let principal: string | undefined = undefined
  let sequence = 0
  let loaded = false
  let closed = false
  let tail = Deferred.makeUnsafe<void>()

  Deferred.doneUnsafe(tail, Effect.void)

  const publish = () => {
    snapshot = Array.from(slots.values(), viewOf(principal))

    for (const listener of listeners)
      try {
        listener(snapshot)
      } catch (error) {
        reportError(error)
      }
  }

  const slotOf = (command: QueuedCommand): Slot<Output> => {
    const failure = Match.value(command.status).pipe(
      Match.withReturnType<Failure | undefined>(),
      Match.when("expired", () => expiredFailure(command.commandId)),
      Match.when("failed", () => options.failureOf(command)),
      Match.orElse(() => undefined),
    )

    return {
      command,
      failure,
      discarded: false,
      settled: Deferred.makeUnsafe<Output, Failure>(),
    }
  }

  const awaitWake = Effect.callback<void>((resume) => {
    const wake = () => resume(Effect.void)

    wakers.add(wake)

    return Effect.sync(() => {
      wakers.delete(wake)
    })
  })

  /** Reads the current principal, and republishes when it changed, since that moves commands in and out of `held`. */
  const current = Effect.gen(function* () {
    const next = yield* options.principal

    if (next !== principal) {
      principal = next
      publish()
    }

    return next
  })

  const sleep = (ms: number) => Effect.raceFirst(Effect.sleep(Duration.millis(ms)), awaitWake)

  const stop = (
    slot: Slot<Output>,
    status: "expired" | "failed",
    failure: Failure,
    answer: QueuedCommand["answer"],
  ) =>
    Effect.gen(function* () {
      slot.command = { ...slot.command, status, answer }
      slot.failure = failure
      yield* Deferred.fail(slot.settled, failure)
      publish()
      yield* guard("save", () => options.store.save(slot.command)).pipe(Effect.catch(report))

      return "settled" as const
    })

  const expire = (slot: Slot<Output>) =>
    stop(slot, "expired", expiredFailure(slot.command.commandId), undefined)

  const commit = (slot: Slot<Output>, value: Output) =>
    Effect.gen(function* () {
      const { commandId } = slot.command

      slots.delete(commandId)
      yield* Deferred.succeed(slot.settled, value)
      publish()
      yield* guard("remove", () => options.store.remove(commandId)).pipe(Effect.catch(report))

      return "settled" as const
    })

  /**
   * Attempts one command until the server answers, its id can no longer be
   * used, or it must wait for the application. A retry never leaves the
   * command's own id, and a retry that would run past the id's window is not
   * made: the command expires instead.
   */
  const deliver = (slot: Slot<Output>) =>
    Effect.gen(function* () {
      const { commandId, target } = slot.command
      const attempt = options.begin(slot.command)
      const deadline = retryDeadline(commandId)

      while (true) {
        if (slot.command.principal !== (yield* current)) return "held" as const

        if (deadline !== undefined && options.now() >= deadline) return yield* expire(slot)

        const outcome = yield* Effect.match(attempt, {
          onSuccess: (value) => ({ answered: true as const, value }),
          onFailure: (refused) => ({ answered: false as const, refused }),
        })

        if (closed || slot.discarded) return "stopped" as const

        if (outcome.answered) return yield* commit(slot, outcome.value)

        const { failure, retryAfterMs, answer } = outcome.refused

        slot.failure = failure
        publish()

        if (Option.isNone(retryAfterMs)) {
          if (isExpired(failure)) return yield* expire(slot)

          if (isCredentialFailure(failure)) {
            parked.add(target)

            return "parked" as const
          }

          if (!(isFramework(failure) && failure.isRetryable))
            return yield* stop(slot, "failed", failure, answer)
        }

        const delay = Option.getOrElse(retryAfterMs, () => IDLE_RETRY_MS)

        if (deadline !== undefined && options.now() + delay >= deadline) return yield* expire(slot)

        yield* sleep(delay)

        if (closed || slot.discarded) return "stopped" as const
      }
    })

  const drain = (target: string) => {
    if (closed || !loaded || draining.has(target) || parked.has(target)) return

    draining.add(target)

    const deliverAll = Effect.gen(function* () {
      while (true) {
        const running = yield* current
        let head: Slot<Output> | undefined = undefined

        for (const slot of slots.values())
          if (
            slot.command.target === target &&
            slot.command.status === "queued" &&
            slot.command.principal === running
          ) {
            head = slot
            break
          }

        if (head === undefined || (yield* deliver(head)) !== "settled") return
      }
    })

    Effect.runFork(
      deliverAll.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            reportError(cause)
            parked.add(target)
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            draining.delete(target)
          }),
        ),
      ),
    )
  }

  const drainQueued = () => {
    for (const slot of slots.values())
      if (slot.command.status === "queued") drain(slot.command.target)
  }

  const load = Effect.gen(function* () {
    const saved = yield* guard("entries", () => options.store.entries())
    const prefix = `/actors/${options.actor}`

    for (const command of saved) {
      sequence = Math.max(sequence, command.sequence + 1)

      if (
        command.baseUrl === options.baseUrl &&
        (command.target === prefix || command.target.startsWith(`${prefix}/`))
      )
        slots.set(command.commandId, slotOf(command))
    }

    loaded = true
    principal = yield* options.principal.pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    publish()
    drainQueued()
    yield* Effect.forkDetach(options.warm)
  })

  Effect.runFork(load.pipe(Deferred.into(loading)))

  const ready = Effect.runPromise(Deferred.await(loading))

  ready.catch(noop)

  const append = (input: NewCommand) =>
    Effect.gen(function* () {
      const existing = slots.get(input.commandId)

      if (existing !== undefined) {
        const { command } = existing

        if (
          command.target !== input.target ||
          command.member !== input.member ||
          command.body !== input.body ||
          command.principal !== (yield* current)
        )
          return yield* ActorError.make({
            reason: CommandConflict.make({ commandId: input.commandId }),
          })

        parked.delete(command.target)
        drain(command.target)

        return {
          settled:
            command.status === "queued"
              ? Deferred.await(existing.settled)
              : Effect.fail(existing.failure ?? expiredFailure(command.commandId)),
        }
      }

      const command: QueuedCommand = {
        ...input,
        baseUrl: options.baseUrl,
        principal: yield* current,
        sequence,
        status: "queued",
        answer: undefined,
      }

      yield* guard("save", () => options.store.save(command))

      sequence += 1

      const slot = slotOf(command)

      slots.set(command.commandId, slot)
      parked.delete(command.target)
      publish()
      drain(command.target)

      return { settled: Deferred.await(slot.settled) }
    })

  const submit = (make: Effect.Effect<NewCommand, Failure>, signal: AbortSignal | undefined) => {
    const previous = tail
    const mine = Deferred.makeUnsafe<void>()
    const aborted = () => signal?.aborted === true

    tail = mine

    return Effect.runPromise(
      Deferred.await(previous).pipe(
        Effect.andThen(Deferred.await(loading)),
        Effect.andThen(
          Effect.gen(function* () {
            if (aborted()) return undefined

            const command = yield* make

            return aborted() ? undefined : yield* append(command)
          }),
        ),
        Effect.ensuring(Deferred.succeed(mine, undefined)),
      ),
    )
  }

  const flush = () => {
    if (closed) return

    parked.clear()

    for (const wake of wakers) wake()

    drainQueued()
  }

  const isOnlineEmitter = "addEventListener" in globalThis

  if (isOnlineEmitter) globalThis.addEventListener("online", flush)

  return {
    ready,
    get pending() {
      return snapshot
    },
    subscribe: (listener) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    flush,
    discard: (commandId) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Deferred.await(loading)

          const slot = slots.get(commandId)

          if (slot === undefined) return

          slot.discarded = true
          slots.delete(commandId)
          yield* Deferred.fail(
            slot.settled,
            ActorError.make({ reason: Timeout.make({ commandId }) }),
          )
          publish()
          yield* guard("remove", () => options.store.remove(commandId))
        }),
      ),
    close: () => {
      closed = true

      for (const wake of wakers) wake()

      listeners.clear()

      if (isOnlineEmitter) globalThis.removeEventListener("online", flush)
    },
    submit,
  }
}
