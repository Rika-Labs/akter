import { Context, DateTime, Duration, Effect, Fiber, Option, Result, Schema } from "effect"
import { InsideTurn, type Mintable } from "../contexts/command.ts"
import type { ConnectionInfo } from "../contexts/connection.ts"
import type { EnqueueOptions } from "../contexts/job.ts"
import { Due, emptyOutbox, InTurn, jobKey, openOutbox } from "../handles/intents.ts"
import { ActorRef, principal } from "../identity/caller.ts"
import { childId } from "../identity/child.ts"
import type { AnyConnection } from "../members/connection.ts"
import type { EventClass } from "../members/event.ts"
import type { AnySubscription, SubscribeFrom } from "../members/subscription.ts"
import type { InternalActors } from "../runtime/actors.ts"
import { isCursor } from "../runtime/events/cursor.ts"
import type {
  Broadcast,
  BusinessResult,
  ConnectionLister,
  EmittedEvent,
  RegisteredCommand,
} from "../runtime/members.ts"
import { Outcome, type Request } from "../runtime/request.ts"
import type { Decoded, Failure, Handler, MemberCodecs, StateValue } from "./codecs.ts"
import { broadcastsTo } from "./connections.ts"
import { type Descriptor, descriptorOf } from "./descriptor.ts"

const utf8 = new TextEncoder()

/**
 * Encoded bytes of every event one turn may emit. The turn appends them in
 * one statement inside its transaction, so the budget bounds that statement.
 */
const MAX_EMIT_BYTES = 1_048_576

/** When and under which key `turn.enqueue` stages a job. */
const enqueueSchedule = (options: EnqueueOptions | undefined) => {
  if (options?.key !== undefined) jobKey(options.key)

  if (options?.after !== undefined && options.at !== undefined)
    throw new Error("turn.enqueue takes after or at, not both")

  let due: Due | undefined

  if (options?.after !== undefined) {
    const millis = Duration.toMillis(Duration.fromInputUnsafe(options.after))

    if (!Number.isFinite(millis) || millis < 0)
      throw new Error("turn.enqueue after needs a finite, non-negative duration")
    due = Due.cases.After.make({ millis: Math.ceil(millis) })
  }

  if (options?.at !== undefined)
    due = Due.cases.At.make({ epochMillis: DateTime.toEpochMillis(options.at) })

  return { due, key: options?.key }
}

/** A declared failure as the turn's failure outcome; any other error is a defect. */
const declaredFailure = Effect.fnUntraced(function* (
  { isError, encodeError }: MemberCodecs,
  error: Failure,
) {
  if (!isError(error)) return yield* Effect.die(error)

  const value = yield* encodeError(error).pipe(Effect.orDie)

  return yield* Effect.fail<BusinessResult>({
    outcome: Outcome.cases.Failure.make({ value }),
    state: [],
    complete: false,
    events: [],
    outbox: emptyOutbox,
  })
})

/** Job tags each actor type has already warned about, so each warns once per process. */
const warned = new WeakMap<Descriptor, Set<string>>()

/**
 * Logs once per job tag that a keyed job routes neither cancellation nor dead
 * letters, since an ambiguous cancellation is then only dead-lettered.
 */
const warnUnrouted = (descriptor: Descriptor, tag: string) =>
  Effect.suspend(() => {
    const policy = descriptor.jobs.get(tag)!.policy
    const tags = warned.get(descriptor) ?? new Set<string>()

    if (tags.has(tag) || policy.onCancelled !== undefined || policy.onDeadLetter !== undefined)
      return Effect.void
    warned.set(descriptor, tags.add(tag))

    return Effect.logWarning(
      `Keyed job ${tag} has neither onCancelled nor onDeadLetter; an ambiguous cancellation is only dead-lettered`,
    )
  })

/**
 * One command member's turn. Its capabilities die once the handler returns
 * and when used from a fiber other than the handler's, because the turn's one
 * connection takes no concurrent statements; forked fibers inherit
 * `InsideTurn`, so the owning fiber is compared as well and a misuse is
 * recorded so a swallowed defect still fails the turn. The turn's services are
 * provided as one merged context, since each nested provide copies it.
 */
const commandTurn = (
  descriptor: Descriptor,
  Turn: Context.Key<object, object>,
  handle: Handler,
  codecs: MemberCodecs,
  services: Context.Context<never>,
  actors: InternalActors["Service"],
) =>
  Effect.fnUntraced(function* (
    request: Request,
    rows: ReadonlyArray<readonly [string, string]>,
    {
      head,
      connections: listConnections,
    }: { readonly head: string; readonly connections?: ConnectionLister | undefined },
  ) {
    const { name, fields } = descriptor
    let open = true
    const broadcasts: Array<Broadcast> = []
    const turn = Symbol()
    const dirty = new Set<string>()
    const emitted: Array<EmittedEvent> = []
    let emittedBytes = 0

    const loaded = yield* descriptor.state.decodeStored(rows)
    let current = loaded.state

    if (loaded.upcast) for (const key of Object.keys(fields)) dirty.add(key)

    const set = (patch: StateValue) =>
      Effect.flatMap(InsideTurn, (inside) => {
        if (!open || inside !== turn)
          return Effect.die(new Error("State capability escaped its turn"))

        for (const key of Object.keys(patch)) {
          if (!(key in fields)) return Effect.die(new Error(`Undeclared state key: ${key}`))
          dirty.add(key)
        }

        return Effect.map(descriptor.state.roundTrip({ ...current, ...patch }), (next) => {
          current = next
        })
      })

    const emit = Effect.fnUntraced(function* (event: { readonly _tag: string }) {
      if (!open || (yield* InsideTurn) !== turn)
        return yield* Effect.die(new Error("Event capability escaped its turn"))

      const declared: EventClass | undefined = descriptor.events.get(event._tag)

      if (declared === undefined || !Schema.is(declared)(event))
        return yield* Effect.die(new Error(`Undeclared event: ${event._tag}`))

      const { value, version } = yield* descriptor.eventCodecs
        .get(declared.identifier)!
        .encode(event)
        .pipe(Effect.orDie)

      emittedBytes += utf8.encode(value).byteLength

      if (emittedBytes > MAX_EMIT_BYTES)
        return yield* Effect.die(
          new Error(`Events emitted in one turn exceed ${MAX_EMIT_BYTES} bytes`),
        )

      emitted.push({ tag: declared.identifier, value, version })
    })

    const view = { set }
    const owner = Fiber.getCurrent()
    let misused: string | undefined

    const escaped = (capability: string) =>
      Effect.gen(function* () {
        if (!open || (yield* InsideTurn) !== turn)
          return yield* Effect.die(new Error(`${capability} capability escaped its turn`))

        if (Fiber.getCurrent() !== owner) {
          misused = `${capability} capability used from a fiber other than its turn's; timeout, race, and concurrent combinators run on other fibers`

          return yield* Effect.die(new Error(misused))
        }
      })

    const wroteTables = new Set<string>()
    const wroteBlobs = new Set<string>()

    const access = yield* actors.tables(
      {
        ref: request.ref,
        placement: descriptor.placement,
        tables: descriptor.tables,
        guard: escaped("Table"),
        wrote: (table) => wroteTables.add(table),
      },
      true,
    )

    const blob = yield* actors.blobs(
      {
        ref: request.ref,
        placement: descriptor.placement,
        blobs: descriptor.blobs,
        guard: escaped("Blob"),
        wrote: (blobName) => wroteBlobs.add(blobName),
        maxBytes: descriptor.policy.blobMaxBytes,
        maxEntries: descriptor.policy.blobMaxEntries,
        timeoutMs: descriptor.policy.executionMs,
      },
      true,
    )

    for (const key of Object.keys(fields))
      Object.defineProperty(view, key, { enumerable: true, get: () => current[key] })

    const outbox = openOutbox({
      sender: request.ref,
      commandId: request.commandId,
      head,
      onBehalfOf: Option.getOrUndefined(principal(request.caller)),
    })

    const mint = Effect.fnUntraced(function* (child: Mintable<string>) {
      yield* escaped("Mint")

      const target = descriptorOf(child)

      if (target === undefined || !target.mintable)
        return yield* Effect.die(
          new Error("turn.mint needs an unkeyed actor that declares createdBy"),
        )

      if (target.parent !== undefined && target.parent.name !== name)
        return yield* Effect.die(
          new Error(`turn.mint(${target.name}) needs a turn of its parent ${target.parent.name}`),
        )

      const proof = outbox.nextMint()

      const minted = yield* actors.mintChildId({
        parent: descriptor.singleton ? { ...request.ref, id: "" } : request.ref,
        commandId: request.commandId,
        ordinal: proof.ordinal,
        child: target.name,
      })

      const id =
        target.parent === undefined ? minted : childId({ parent: request.ref.id, local: minted })

      outbox.minted(
        ActorRef.make({ tenant: request.ref.tenant, actor: target.name, id }),
        target.policy.createdBy!,
        proof,
      )

      return id
    })

    const enqueue = Effect.fnUntraced(function* (
      instance: { readonly _tag: string },
      options?: EnqueueOptions,
    ) {
      if (!open || (yield* InsideTurn) !== turn)
        return yield* Effect.die(new Error("Job capability escaped its turn"))

      const declared = descriptor.jobs.get(instance._tag)

      if (declared === undefined)
        return yield* Effect.die(new Error(`Unbound job: ${instance._tag}`))

      const scheduled = yield* Effect.sync(() => enqueueSchedule(options))

      if (scheduled.key !== undefined) yield* warnUnrouted(descriptor, instance._tag)
      const { value, version } = yield* declared.codec.encode(instance).pipe(Effect.orDie)

      outbox.enqueue({
        job: instance._tag,
        payload: value,
        version,
        capped: declared.policy.perActor !== undefined,
        ...scheduled,
      })
    })

    const changeSubscription = (op: "subscribe" | "remove") =>
      Effect.fnUntraced(function* (
        declared: AnySubscription,
        id: string,
        options?: { readonly from?: SubscribeFrom },
      ) {
        yield* escaped("Subscription")

        if (!descriptor.subscriptions.includes(declared) || declared.route !== undefined)
          return yield* Effect.die(
            new Error(`${declared.tag} is not a dynamic subscription of ${name}`),
          )

        const source = descriptorOf(declared.source)!
        const from = options?.from ?? "now"

        if (from !== "now" && from !== "start" && !isCursor(from))
          return yield* Effect.die(
            new Error(`subscribe from is "now", "start", or a cursor, not ${from}`),
          )

        outbox.subscribe({
          subscription: declared.tag,
          source: ActorRef.make({
            tenant: request.ref.tenant,
            actor: declared.source.name,
            id: yield* source.decodeId(id).pipe(Effect.orDie),
          }),
          op,
          from,
          events: declared.events.map((event) => event.identifier),
        })
      })

    const cancelJob = Effect.fnUntraced(function* (key: string) {
      if (!open || (yield* InsideTurn) !== turn)
        return yield* Effect.die(new Error("Job capability escaped its turn"))

      yield* Effect.sync(() => jobKey(key))
      outbox.cancelJob(key)
    })

    const context = {
      id: request.ref.id,
      ref: request.ref,
      caller: request.caller,
      principal: principal(request.caller),
      commandId: request.commandId,
      state: Object.freeze(view),
      emit,
      rows: access.rows,
      group: access.group,
      blob,
      mint,
      enqueue,
      cancelJob,
      broadcast: broadcastsTo({ descriptor, broadcasts, guard: escaped }),
      subscribe: changeSubscription("subscribe"),
      unsubscribe: (declared: AnySubscription, id: string) =>
        changeSubscription("remove")(declared, id),
      connections: (member: AnyConnection): Effect.Effect<ReadonlyArray<ConnectionInfo>> =>
        Effect.gen(function* () {
          yield* escaped("Connections")

          if (listConnections === undefined) return []

          return (yield* listConnections(member.tag)).map(({ connectionId, caller }) => ({
            connectionId,
            caller,
          }))
        }),
    }

    const succeeded = (output: Decoded): Effect.Effect<BusinessResult> => {
      if (misused !== undefined) return Effect.die(new Error(misused))

      const uncreated = outbox.uncreated()

      if (uncreated !== undefined)
        return Effect.die(
          new Error(`Minted actor ${uncreated.actor}/${uncreated.id} has no creating intent`),
        )

      const keyed = outbox.keyedCreation()

      if (keyed !== undefined)
        return Effect.die(
          new Error(`Minted actor ${keyed.actor}/${keyed.id} has a keyed creating intent`),
        )

      return Effect.flatMap(codecs.encodeSuccess({ value: output }).pipe(Effect.orDie), (value) =>
        Effect.map(descriptor.state.writes(current, dirty), (state): BusinessResult => ({
          outcome: Outcome.cases.Success.make({ value }),
          state,
          complete: loaded.upcast,
          events: emitted,
          outbox: outbox.close(),
          broadcasts,
          writes: { tables: [...wroteTables], blobs: [...wroteBlobs] },
        })),
      )
    }

    return yield* codecs.decodePayload(request.payload).pipe(
      Effect.orDie,
      Effect.flatMap((input) => handle(input.value)),
      Effect.flatMap(succeeded),
      Effect.catch((error) => declaredFailure(codecs, error)),
      Effect.ensuring(
        Effect.sync(() => {
          open = false
          outbox.close()
        }),
      ),
      Effect.provideContext(
        Context.merge(Context.make(InsideTurn, turn), services).pipe(
          Context.add(InTurn, outbox.marker),
          Context.add(Turn, context),
        ),
      ),
    ) as Effect.Effect<BusinessResult, BusinessResult>
  })

/**
 * A reducer's turns. `reduce` receives its own decoded copy of state, so
 * mutating it in place cannot hide a change, and its result round-trips
 * through the state schema. A batched reducer's queued inputs are combined in
 * order and reduced once; it declares no errors, so a combined turn fails only
 * by defect.
 */
const reducerTurns = (
  descriptor: Descriptor,
  reducer: Descriptor["reducers"][number],
): RegisteredCommand => {
  const codecs = descriptor.codecs.get(reducer.tag)!

  const reduceOnce = Effect.fnUntraced(function* (
    rows: ReadonlyArray<readonly [string, string]>,
    input: Decoded,
  ) {
    const loaded = yield* descriptor.state.decodeStored(rows)
    const given = yield* descriptor.state.roundTrip(loaded.state)
    const reduced = reducer.reduce(given, input)

    if (Result.isFailure(reduced)) return yield* declaredFailure(codecs, reduced.failure)

    const next = yield* descriptor.state.roundTrip(reduced.success)

    const dirty = new Set(
      Object.keys(descriptor.fields).filter(
        (key) =>
          loaded.upcast || !descriptor.state.equivalences[key]!(loaded.state[key], next[key]),
      ),
    )

    const value = yield* codecs
      .encodeSuccess({ value: reducer.batch === undefined ? next : undefined })
      .pipe(Effect.orDie)

    return {
      outcome: Outcome.cases.Success.make({ value }),
      state: yield* descriptor.state.writes(next, dirty),
      complete: loaded.upcast,
      events: [],
      outbox: emptyOutbox,
    } satisfies BusinessResult
  })

  const decodePayload = (request: Request) =>
    codecs.decodePayload(request.payload).pipe(
      Effect.orDie,
      Effect.map((input) => input.value),
    )

  const single: RegisteredCommand = {
    internal: false,
    handler: false,
    run: Effect.fnUntraced(function* (request, rows) {
      return yield* reduceOnce(rows, yield* decodePayload(request))
    }),
  }

  const batch = reducer.batch

  if (batch === undefined) return single

  return {
    ...single,
    merge: Effect.fnUntraced(function* (requests, rows) {
      const inputs = yield* Effect.forEach(requests, decodePayload)
      const combined = inputs.reduce((first, second) => batch.combine(first, second))

      return yield* reduceOnce(rows, combined).pipe(
        Effect.catch(() => Effect.die(new Error(`Batched reducer ${reducer.tag} failed`))),
      )
    }),
  }
}

/** Every command and reducer turn of one activation, keyed by tag. */
export const turnsOf = ({
  descriptor,
  Turn,
  handlers,
  services,
  actors,
}: {
  readonly descriptor: Descriptor
  readonly Turn: Context.Key<object, object>
  readonly handlers: Readonly<Record<string, Handler>>
  readonly services: Context.Context<never>
  readonly actors: InternalActors["Service"]
}) =>
  Effect.gen(function* () {
    const commands = new Map<string, RegisteredCommand>()

    for (const member of descriptor.commands) {
      const handle = handlers[member.tag]

      if (handle === undefined) return yield* Effect.die(new Error(`Missing handler ${member.tag}`))

      commands.set(member.tag, {
        internal: descriptor.internalMembers.has(member),
        handler: descriptor.handlerTags.has(member.tag),
        run: commandTurn(
          descriptor,
          Turn,
          handle,
          descriptor.codecs.get(member.tag)!,
          services,
          actors,
        ),
      })
    }

    for (const reducer of descriptor.reducers)
      commands.set(reducer.tag, reducerTurns(descriptor, reducer))

    return commands as ReadonlyMap<string, RegisteredCommand>
  })
