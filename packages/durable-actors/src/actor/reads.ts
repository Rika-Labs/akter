import { Context, DateTime, Effect, Fiber, Schema, Stream } from "effect"
import {
  type EventEntry,
  InsideTurn,
  InStream,
  type ProgressEntry,
  type QueryContext,
} from "../contexts/command.ts"
import { CurrentCaller, principal, Tenant } from "../identity/caller.ts"
import { DEFAULT_REPLAY_LIMIT, type EventClass, MAX_REPLAY_LIMIT } from "../members/event.ts"
import type { AnyStream } from "../members/stream.ts"
import type { AnyJob } from "../members/job.ts"
import type { InternalActors } from "../runtime/actors.ts"
import type { ReadSet } from "../runtime/connections/reads.ts"
import type {
  EventReader,
  RegisteredQuery,
  RegisteredStream,
  StoredEvent,
  StreamInput,
} from "../runtime/members.ts"
import { Outcome } from "../runtime/request.ts"
import { ownership } from "../tables/owned.ts"
import type { Decoded, Handler, StateValue, StreamHandler } from "./codecs.ts"
import type { Descriptor } from "./descriptor.ts"

type AnyQueryContext = QueryContext<StateValue, EventClass, never, never, AnyJob>

/** A committed event decoded at the class's current version, with its cursor and command. */
const entryOf = (descriptor: Descriptor, event: EventClass, stored: StoredEvent) =>
  Effect.map(
    descriptor.eventCodecs
      .get(event.identifier)!
      .decode(stored.value, stored.version)
      .pipe(Effect.orDie),
    (decoded): EventEntry<Decoded> => ({
      cursor: stored.cursor,
      event: decoded,
      commandId: stored.commandId,
      timestamp: DateTime.makeUnsafe(stored.timestampMs),
    }),
  )

/**
 * `read.events` over `readEvents`: an undeclared event class or a `limit`
 * outside 1..10,000 is a defect of the handler. `label` names the capability
 * in that defect.
 */
export const eventsWith =
  ({
    descriptor,
    readEvents,
    label = "read.events",
  }: {
    readonly descriptor: Descriptor
    readonly readEvents: EventReader
    readonly label?: string
  }) =>
  (
    event: EventClass,
    options?: { readonly after?: string | undefined; readonly limit?: number | undefined },
  ) =>
    Effect.gen(function* () {
      if (descriptor.events.get(event.identifier) !== event)
        return yield* Effect.die(new Error(`Undeclared event: ${event.identifier}`))

      const limit = options?.limit ?? DEFAULT_REPLAY_LIMIT

      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPLAY_LIMIT)
        return yield* Effect.die(
          new Error(`${label} limit must be an integer from 1 to ${MAX_REPLAY_LIMIT}`),
        )

      return yield* Effect.forEach(
        yield* readEvents(event.identifier, options?.after, limit),
        (stored) => entryOf(descriptor, event, stored),
      )
    })

const recordingRead = (context: AnyQueryContext, reads: ReadSet): AnyQueryContext => ({
  get id() {
    reads.caller = true

    return context.id
  },
  get ref() {
    reads.caller = true

    return context.ref
  },
  get caller() {
    reads.caller = true

    return context.caller
  },
  get principal() {
    reads.caller = true

    return context.principal
  },
  get state() {
    reads.state = true

    return context.state
  },
  cursor: context.cursor,
  events: (event, options) => {
    reads.events.add(event.identifier)

    return context.events(event, options)
  },
  rows: (table) => {
    reads.tables.add(ownership(table)?.name ?? "")

    return context.rows(table)
  },
  get group() {
    reads.group = true

    return context.group
  },
  blob: (declared) => {
    reads.blobs.add((declared as { readonly name: string }).name)

    return context.blob(declared)
  },
  follow: context.follow,
  progress: context.progress,
})

/**
 * Registers every query's handler. A query runs with its own `InsideTurn`
 * marker, so a command or query call from it is a defect instead of a write,
 * and its capabilities die once it returns or from another fiber. A watched
 * run records what it reads; a `watch: true` handler gets no layer services.
 */
export const queriesOf = ({
  descriptor,
  Read,
  handlers,
  services,
  actors,
}: {
  readonly descriptor: Descriptor
  readonly Read: Context.Key<object, object>
  readonly handlers: Readonly<Record<string, Handler>>
  readonly services: Context.Context<never>
  readonly actors: InternalActors["Service"]
}) =>
  Effect.gen(function* () {
    const registered = new Map<string, RegisteredQuery>()

    for (const member of descriptor.queries) {
      const handle = handlers[member.tag]

      if (handle === undefined)
        return yield* Effect.die(new Error(`Missing query handler ${member.tag}`))

      const { decodePayload, encodeSuccess, isError, encodeError } = descriptor.codecs.get(
        member.tag,
      )!

      const watch = descriptor.watches.has(member.tag)

      registered.set(member.tag, {
        watch,
        run: Effect.fnUntraced(function* (request, rows, cursor, readEvents, reads) {
          const { state } = yield* descriptor.state.decodeStored(rows)
          let open = true
          const query = Symbol()
          const owner = Fiber.getCurrent()

          const escaped = (capability: string) =>
            Effect.gen(function* () {
              if (!open || (yield* InsideTurn) !== query)
                return yield* Effect.die(new Error(`${capability} capability escaped its query`))

              if (Fiber.getCurrent() !== owner)
                return yield* Effect.die(
                  new Error(
                    `${capability} capability used from a fiber other than its query's; timeout, race, and concurrent combinators run on other fibers`,
                  ),
                )
            })

          const access = yield* actors.tables(
            {
              ref: request.ref,
              placement: descriptor.placement,
              tables: descriptor.tables,
              guard: escaped("Table"),
            },
            false,
          )

          const blob = yield* actors.blobs(
            {
              ref: request.ref,
              placement: descriptor.placement,
              blobs: descriptor.blobs,
              guard: escaped("Blob"),
              maxBytes: descriptor.policy.blobMaxBytes,
              maxEntries: descriptor.policy.blobMaxEntries,
              timeoutMs: descriptor.policy.executionMs,
            },
            false,
          )

          const context: AnyQueryContext = {
            id: request.ref.id,
            ref: request.ref,
            caller: request.caller,
            principal: principal(request.caller),
            state: Object.freeze(state),
            cursor,
            events: eventsWith({ descriptor, readEvents }) as AnyQueryContext["events"],
            rows: access.rows as AnyQueryContext["rows"],
            group: access.group,
            blob: blob as AnyQueryContext["blob"],
            follow: () => Stream.die(new Error("read.follow is only available in stream handlers")),
            progress: () => Stream.die(new Error("Progress is only available in stream handlers")),
          }

          return yield* Effect.gen(function* () {
            const input = yield* decodePayload(request.payload).pipe(Effect.orDie)
            const output = yield* handle(input.value)
            const value = yield* encodeSuccess({ value: output }).pipe(Effect.orDie)

            return Outcome.cases.Success.make({ value })
          }).pipe(
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (!isError(error)) return yield* Effect.die(error)

                const value = yield* encodeError(error).pipe(Effect.orDie)

                return Outcome.cases.Failure.make({ value })
              }),
            ),
            Effect.catchDefect((cause) => Effect.succeed(Outcome.cases.Defect.make({ cause }))),
            Effect.ensuring(
              Effect.sync(() => {
                open = false
              }),
            ),
            Effect.provideService(
              Read,
              reads === undefined ? context : recordingRead(context, reads),
            ),
            Effect.provideContext(watch ? Context.empty() : services),
            Effect.provideService(InsideTurn, query),
          ) as Effect.Effect<Outcome>
        }),
      })
    }

    return registered as ReadonlyMap<string, RegisteredQuery>
  })

/**
 * A stream member's live feed for one subscriber. It runs on the activation
 * with its own `InsideTurn` marker and `InStream`, and its capabilities die
 * once the stream ends. `read.progress` reaches only jobs its member lists.
 */
export const streamOf = ({
  descriptor,
  Read,
  member,
  handle,
  services,
  actors,
}: {
  readonly descriptor: Descriptor
  readonly Read: Context.Key<object, object>
  readonly member: AnyStream
  readonly handle: StreamHandler
  readonly services: Context.Context<never>
  readonly actors: InternalActors["Service"]
}): RegisteredStream => {
  const { decodePayload, encodeSuccess, isError, encodeError } = descriptor.codecs.get(member.tag)!

  const progressCodecs = new Map(
    (member.progress?.jobs ?? []).map((job) => [
      job.tag,
      {
        job: Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(job))),
        frame: Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(job.progress))),
      },
    ]),
  )

  return {
    progress: new Set(progressCodecs.keys()),
    run: (payload: string, input: StreamInput) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { state } = yield* descriptor.state.decodeStored(input.state)
          let open = true
          const stream = Symbol()

          const guard = (capability: string) =>
            open
              ? Effect.void
              : Effect.die(new Error(`${capability} capability escaped its stream`))

          const access = yield* actors.tables(
            {
              ref: input.ref,
              placement: descriptor.placement,
              tables: descriptor.tables,
              guard: guard("Table"),
            },
            false,
          )

          const blob = yield* actors.blobs(
            {
              ref: input.ref,
              placement: descriptor.placement,
              blobs: descriptor.blobs,
              guard: guard("Blob"),
              maxBytes: descriptor.policy.blobMaxBytes,
              maxEntries: descriptor.policy.blobMaxEntries,
              timeoutMs: descriptor.policy.executionMs,
            },
            false,
          )

          const context: AnyQueryContext = {
            id: input.ref.id,
            ref: input.ref,
            caller: input.caller,
            principal: principal(input.caller),
            state: Object.freeze(state),
            cursor: input.cursor,
            events: eventsWith({
              descriptor,
              readEvents: input.events,
            }) as AnyQueryContext["events"],
            rows: access.rows as AnyQueryContext["rows"],
            group: access.group,
            blob: blob as AnyQueryContext["blob"],
            follow: ((event: EventClass, options?: { readonly after?: string | undefined }) =>
              descriptor.events.get(event.identifier) !== event
                ? Stream.die(new Error(`Undeclared event: ${event.identifier}`))
                : input
                    .follow(event.identifier, options?.after)
                    .pipe(
                      Stream.mapEffect((stored) => entryOf(descriptor, event, stored)),
                    )) as AnyQueryContext["follow"],
            progress: ((job: AnyJob, options?: { readonly jobId?: string | undefined }) => {
              const codecs = progressCodecs.get(job.tag)

              if (codecs === undefined || member.progress?.jobs.includes(job as never) !== true)
                return Stream.die(
                  new Error(`Stream ${member.tag} does not list progress of ${job.tag}`),
                )

              return input.progress(job.tag, options?.jobId).pipe(
                Stream.mapEffect((stored) =>
                  Effect.gen(function* () {
                    const entry: ProgressEntry<never> = {
                      jobId: stored.effectId,
                      job: (yield* codecs.job(stored.effect)) as never,
                      attempt: stored.attempt,
                      seq: stored.seq,
                      frame: (yield* codecs.frame(stored.frame)) as never,
                    }

                    return entry
                  }).pipe(Effect.orDie),
                ),
              )
            }) as AnyQueryContext["progress"],
          }

          const { value } = yield* decodePayload(payload).pipe(Effect.orDie)

          return handle(value).pipe(
            Stream.mapEffect((output) => encodeSuccess({ value: output }).pipe(Effect.orDie)),
            Stream.catch((error) =>
              isError(error)
                ? Stream.fromEffect(
                    Effect.flatMap(encodeError(error).pipe(Effect.orDie), (failure) =>
                      Effect.fail({ failure }),
                    ),
                  )
                : Stream.die(error),
            ),
            Stream.ensuring(Effect.sync(() => (open = false))),
            Stream.provideService(Read, context),
            Stream.provideService(InStream, { stream }),
            Stream.provideContext(services),
            Stream.provideService(CurrentCaller, input.caller),
            Stream.provideService(Tenant, input.ref.tenant),
            Stream.provideService(InsideTurn, stream),
          ) as Stream.Stream<string, { readonly failure: string }>
        }),
      ),
  }
}
