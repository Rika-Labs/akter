import { Effect, Exit, Option, Schema, SchemaAST, Stream } from "effect"
import type { ServedDefinition, ServedMember, StateValue } from "../actor/served.ts"
import { ActorError, InvalidInput, Timeout } from "../errors/actor.ts"
import type { AnyMember, MemberRecord, ValueSchema } from "../members/command.ts"
import type { AnyConnection } from "../members/connection.ts"
import type { AnyStream } from "../members/stream.ts"
import type { EventClass } from "../members/event.ts"
import { callsOf, declaredDecoder, joinUrl, uuid } from "./calls.ts"
import {
  type ClientConnection,
  type ConnectOptions,
  connect,
  type ProgressOfConnection,
} from "./sessions/connection.ts"
import { type FeedEntry, type FeedOptions, feedStream } from "./sessions/feed.ts"
import { type StreamOptions, subscription } from "./sessions/stream.ts"
import { type WatchOptions, watchStream } from "./sessions/watch.ts"
import type { OfflineQueue } from "./offline/queue.ts"
import type { OfflineStore } from "./offline/store.ts"
import { Optimistic, type PendingInput } from "./optimistic.ts"
import { type Failure, undecodableFailure } from "./transport.ts"

type HeadersValue = Readonly<Record<string, string>> | Headers | Array<[string, string]>

/** Headers sent with every attempt; a function is called again for each attempt, including retries. */
export type HeadersProvider = HeadersValue | (() => HeadersValue | Promise<HeadersValue>)

/** Options of `X.client`. */
export interface ClientOptions {
  /** Where `Actor.serve` is mounted, absolute or relative to the page. */
  readonly baseUrl: string
  /**
   * Headers for every request. A connection sends the `authorization` header
   * in `hello` instead, because browsers can't set headers on a WebSocket.
   */
  readonly headers?: HeadersProvider
  /** How long one call, retries included, may wait. Defaults to 60,000. */
  readonly timeoutInMs?: number
  /** Defaults to the global `fetch`. */
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /**
   * `client` (default) mints ids from the database clock learned through
   * `/protocol`; `server` asks `/command-ids` for each one.
   */
  readonly commandIds?: "client" | "server"
  /**
   * Saves every command before its first attempt and delivers it in order per
   * actor under its original id, across outages and reloads; see
   * `ActorClient.offline`. Queries and streams are unaffected.
   */
  readonly offline?: OfflineStore
  /**
   * A stable key for who the client runs as, such as the signed-in user's id,
   * read before each offline command is saved and before each attempt. The
   * offline queue sends only the commands saved under the current key and
   * holds the rest. Never a credential. Without it, the key is the `iss` and
   * `sub` of an `authorization: Bearer` JWT, and an offline client with
   * neither refuses to queue commands.
   */
  readonly identity?: () => string | Promise<string>
}

/** Options of one query call. */
export interface QueryOptions {
  /** Stops waiting; server work already accepted is not cancelled. */
  readonly signal?: AbortSignal
  /** Overrides `ClientOptions.timeoutInMs` for this call. */
  readonly timeoutInMs?: number
}

/** Options of one command call. */
export interface CommandOptions extends QueryOptions {
  /** Sent as `Idempotency-Key` on every attempt; minted once when omitted. */
  readonly commandId?: string
}

/**
 * The `watch` of a query declared `watch: true`: an `AsyncIterable` of the
 * query's current result and then its newest result after each change. It is
 * state, not history: intermediate results are skipped and a reconnect sends the
 * current result first, never one older than one already delivered.
 */
export type WatchCall<M extends AnyMember> = (
  ...args: M["input"]["Type"] extends void
    ? [options?: WatchOptions]
    : [input: M["input"]["Type"], options?: WatchOptions]
) => AsyncIterable<M["output"]["Type"]>

type Call<M extends AnyMember> = (M["input"]["Type"] extends void
  ? (
      options?: M["kind"] extends "query" ? QueryOptions : CommandOptions,
    ) => Promise<M["output"]["Type"]>
  : (
      input: M["input"]["Type"],
      options?: M["kind"] extends "query" ? QueryOptions : CommandOptions,
    ) => Promise<M["output"]["Type"]>) &
  (M extends { readonly watch: true } ? { readonly watch: WatchCall<M> } : unknown)

/**
 * A handle's view of its actor's state: the committed state it last learned,
 * from a reducer's reply or `reconcile`, with its pending reducer inputs applied.
 * Reducer calls send one at a time, so each reply is the committed state
 * before every later pending input. The view has settled before the caller's
 * own callbacks run, and a listener that calls another reducer queues it
 * behind the current one.
 */
export interface ClientState<State> {
  /** Committed state plus pending inputs; undefined until committed state is known. */
  readonly current: State | undefined
  /** Reducer inputs applied ahead of their receipts, in call order. */
  readonly pending: ReadonlyArray<PendingInput>
  /** Calls `listener` with `current` after each change; returns the unsubscribe. */
  readonly subscribe: (listener: (state: State | undefined) => void) => () => void
  /** Replaces the committed state, e.g. with one a query read, and reapplies pending inputs. */
  readonly reconcile: (committed: State) => void
}

/** A connection member: `connect` opens one session over WebSocket. */
export interface ConnectionClient<M extends AnyConnection> {
  /** Opens a session; the `authorization` header from `headers` travels in `hello`. */
  readonly connect: (
    ...args: M["input"]["Type"] extends void
      ? [params?: M["input"]["Type"], options?: ConnectOptions]
      : [params: M["input"]["Type"], options?: ConnectOptions]
  ) => Promise<ClientConnection<M["server"]["Type"], M["client"]["Type"], ProgressOfConnection<M>>>
}

/** A stream member: each call subscribes once, as an `AsyncIterable` of its elements. */
export type StreamCall<M extends AnyStream> = (
  ...args: M["input"]["Type"] extends void
    ? [options?: StreamOptions]
    : [input: M["input"]["Type"], options?: StreamOptions]
) => AsyncIterable<M["output"]["Type"]>

/** One actor over HTTP: each public member as a Promise-returning method, connections as `connect`. */
export type ClientHandle<
  Members extends MemberRecord,
  Id = string,
  State = unknown,
  Events extends EventClass = never,
> = {
  readonly [K in keyof Members]: Members[K] extends AnyConnection
    ? ConnectionClient<Members[K]>
    : Members[K] extends AnyStream
      ? StreamCall<Members[K]>
      : Call<Members[K]>
} & {
  /** The actor type's name and this handle's id. */
  readonly ref: { readonly actor: string; readonly id: Id }
  /** The handle's committed and optimistic state. */
  readonly state: ClientState<State>
  /**
   * The actor's committed `event`s after `options.after`, over its event feed,
   * as they commit. Only events the actor type lists in `feeds` are served.
   */
  readonly events: <E extends Events>(
    event: E,
    options?: FeedOptions,
  ) => AsyncIterable<FeedEntry<E["Type"]>>
}

/** The client of one actor type: `get` (and `create` for minted ids) return handles. */
export type ActorClient<
  Members extends MemberRecord,
  Kind extends ServedDefinition["key"],
  Id,
  State = unknown,
  Events extends EventClass = never,
> = {
  /** A fresh command id, for a caller that saves it before sending the command. */
  readonly commandId: () => Promise<string>
  /**
   * The persisted command queue when `ClientOptions.offline` is set, else
   * `undefined`. A command call then resolves with its output once the server
   * answers, and rejects with `Timeout` carrying the command's id if the
   * call's own timeout or signal ends the wait first; the command stays
   * queued and is still delivered under that id.
   */
  readonly offline: OfflineQueue | undefined
} & (Kind extends "singleton"
  ? { readonly get: () => ClientHandle<Members, string, State, Events> }
  : Kind extends "minted"
    ? {
        readonly get: (id: Id) => ClientHandle<Members, Id, State, Events>
        /** A handle to a new actor whose UUIDv7 id is minted here; it exists once a command reaches it. */
        readonly create: () => ClientHandle<Members, Id, State, Events>
      }
    : { readonly get: (id: Id) => ClientHandle<Members, Id, State, Events> })

/** Handles kept per client. */
const HANDLE_LIMIT = 1_024

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const invalid = () => ActorError.make({ reason: InvalidInput.make({ code: "decode" }) })

/**
 * A connection's WebSocket URL from its route's URL, resolved against the page
 * when relative: `wss:` for `https:` or `wss:`, and `ws:` otherwise.
 */
export const socketUrl = (route: string) => {
  const url = new URL(route, "location" in globalThis ? globalThis.location.href : undefined)

  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:"

  return url.href
}

const decodeInputCopy = (member: ServedMember) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(member.input)))

const isVoidInput = (member: ServedMember) =>
  SchemaAST.isVoid(member.input.ast) || SchemaAST.isUndefined(member.input.ast)

/**
 * The Promise client of one served actor type, typed by its caller.
 *
 * Every response carries `durable-now`, so each round trip refreshes the
 * database clock, except a 504, which waited out a deadline and says little
 * about when it was stamped. `/protocol` is read again when no recent clock
 * sample remains, since the offset may have drifted, and a `window` rejection
 * clears the cached window because a deployment at this URL may have changed
 * it. Without a usable clock sample, such as after a slow `/protocol`, the
 * server mints the id instead. An unanswered command's outcome is unknown, so
 * its `Timeout` carries the id a caller retries later. Past 1,024 handles the
 * least recently used other handle with nothing pending and no listener is
 * dropped.
 */
export const clientOf =
  <Client>(definition: ServedDefinition) =>
  (options: ClientOptions): Client => {
    const {
      authorization,
      token,
      openEvents,
      mint,
      waiting,
      withRetries,
      asAttempt,
      poster,
      queue,
      commandId: mintCommandId,
    } = callsOf({ definition, options })

    /**
     * Encodes one call's input now, so every attempt under one id sends the same
     * bytes, and returns what sends it, with a decoded copy of that input.
     */
    const prepare = (
      member: ServedMember,
      segment: Effect.Effect<string, ActorError>,
      args: ReadonlyArray<unknown>,
    ) => {
      const isVoid = isVoidInput(member)
      const call: CommandOptions = (isVoid ? args[0] : args[1]) ?? {}
      const isQuery = member.kind === "query"
      let commandId = isQuery ? undefined : call.commandId

      const body = Effect.runSyncExit(
        Schema.encodeUnknownEffect(Schema.toCodecJson(member.input))(
          isVoid ? undefined : args[0],
        ).pipe(
          Effect.flatMap((json) =>
            json === undefined ? Effect.succeedNone : Effect.asSome(encodeJson(json)),
          ),
          Effect.mapError(invalid),
        ),
      )

      const post = poster(member)

      const attempt = Effect.gen(function* () {
        const path = `/actors/${definition.name}${yield* segment}/${member.tag}`
        const payload = Option.getOrUndefined(yield* body)

        if (!isQuery && commandId === undefined) commandId = yield* mint

        return yield* post(path, payload, commandId)
      }).pipe(Effect.mapError((error) => asAttempt(commandId)(error)))

      const input = Exit.isSuccess(body)
        ? Option.getOrUndefined(
            Exit.getSuccess(
              Effect.runSyncExit(
                Option.match(body.value, {
                  onNone: () => Effect.void,
                  onSome: (json) => decodeInputCopy(member)(json),
                }),
              ),
            ),
          )
        : undefined

      /**
       * Saves this command in the offline queue, minting its id first when the
       * caller gave none, and reports when it is delivered. `call` is the
       * caller's view, bounded by its timeout and signal; `delivered` outlives
       * both, so state that follows the command follows its real outcome.
       */
      const enqueue =
        queue === undefined || isQuery
          ? undefined
          : () => {
              const make = Effect.gen(function* () {
                const target = `/actors/${definition.name}${yield* segment}`
                const payload = Option.getOrUndefined(yield* body)

                commandId ??= yield* mint

                return { commandId, target, member: member.tag, body: payload }
              })

              const delivered = queue.submit(make, call.signal).then((delivery) =>
                delivery === undefined
                  ? Promise.reject(
                      ActorError.make({
                        reason: Timeout.make(commandId === undefined ? {} : { commandId }),
                      }),
                    )
                  : Effect.runPromise(delivery.settled),
              )

              return {
                delivered,
                call: waiting(
                  Effect.tryPromise({
                    try: () => delivered,
                    catch: (thrown) => thrown as Failure,
                  }),
                  call,
                  () => commandId,
                ),
              }
            }

      return {
        input: Exit.isSuccess(body) ? Option.some(input) : Option.none(),
        send: (after?: Promise<void>) => withRetries(attempt, call, () => commandId, after),
        enqueue,
      }
    }

    const method =
      (member: ServedMember, segment: Effect.Effect<string, ActorError>, store: Optimistic) =>
      (...args: ReadonlyArray<unknown>) => {
        const { input, send, enqueue } = prepare(member, segment, args)
        const reducer = member.reducer

        if (reducer === undefined || Option.isNone(input))
          return enqueue === undefined ? send() : enqueue().call

        const entry = { member: member.tag, input: input.value, reducer }

        if (enqueue === undefined) return store.sendInOrder(entry, send)

        const { call, delivered } = enqueue()

        store.follow(entry, delivered)

        return call
      }

    const handles = new Map<string, object>()
    const stores = new Map<string, Optimistic>()

    const handle = (id: string, segment: Effect.Effect<string, ActorError>) => {
      const existing = handles.get(id)
      const existingStore = stores.get(id)

      if (existing !== undefined && existingStore !== undefined) {
        handles.delete(id)
        handles.set(id, existing)

        return existing
      }

      const store = new Optimistic(
        definition.members.find((member) => member.reducer !== undefined)?.reducer,
      )

      const path = (member: string) =>
        segment.pipe(Effect.map((encoded) => `/actors/${definition.name}${encoded}/${member}`))

      const watching =
        (member: ServedMember) =>
        (...args: ReadonlyArray<unknown>) => {
          const isVoid = isVoidInput(member)
          const watchOptions: WatchOptions = (isVoid ? args[0] : args[1]) ?? {}

          const body = Schema.encodeUnknownEffect(Schema.toCodecJson(member.input))(
            isVoid ? undefined : args[0],
          ).pipe(
            Effect.flatMap((json) =>
              json === undefined ? Effect.succeedNone : Effect.asSome(encodeJson(json)),
            ),
            Effect.map(Option.getOrUndefined),
            Effect.mapError(invalid),
          )

          return Stream.toAsyncIterable(
            watchStream({
              decode: (json) =>
                Schema.decodeEffect(Schema.toCodecJson(member.output))(json).pipe(
                  Effect.mapError(undecodableFailure),
                ),
              declared: declaredDecoder(member),
              options: watchOptions,
              token: () => token.value,
              open: (version, signal) =>
                Effect.gen(function* () {
                  const payload = yield* body
                  const headers: Record<string, string> = {}

                  if (payload !== undefined) headers["content-type"] = "application/json"

                  if (version !== undefined) headers["durable-min-version"] = version

                  return yield* openEvents(
                    path(member.tag).pipe(Effect.map((query) => `${query}/watch`)),
                    signal,
                    { method: "POST", body: payload, headers },
                  )
                }),
            }),
          )
        }

      const created = {
        ...Object.fromEntries(
          definition.members.map((member) => [
            member.tag,
            member.watch
              ? Object.assign(method(member, segment, store), { watch: watching(member) })
              : method(member, segment, store),
          ]),
        ),
        ...Object.fromEntries(
          definition.connections.map((member) => [
            member.tag,
            {
              connect: (params: ValueSchema["Type"], connectOptions?: ConnectOptions) =>
                Effect.runPromise(path(member.tag)).then((memberPath) =>
                  connect({
                    member,
                    url: socketUrl(joinUrl({ baseUrl: options.baseUrl, path: memberPath })),
                    authorization,
                    params,
                    options: connectOptions ?? {},
                  }),
                ),
            },
          ]),
        ),
        ...Object.fromEntries(
          definition.streams.map((member) => [
            member.tag,
            (...args: ReadonlyArray<unknown>) => {
              const isVoid = isVoidInput(member)
              const streamOptions: StreamOptions = (isVoid ? args[0] : args[1]) ?? {}

              const body = Schema.encodeUnknownEffect(Schema.toCodecJson(member.input))(
                isVoid ? undefined : args[0],
              ).pipe(
                Effect.flatMap((json) =>
                  json === undefined ? Effect.succeedNone : Effect.asSome(encodeJson(json)),
                ),
                Effect.map(Option.getOrUndefined),
                Effect.mapError(invalid),
              )

              return Stream.toAsyncIterable(
                subscription({
                  member,
                  declared: declaredDecoder(member),
                  options: streamOptions,
                  open: (signal) =>
                    Effect.gen(function* () {
                      const payload = yield* body

                      return yield* openEvents(path(member.tag), signal, {
                        method: "POST",
                        body: payload,
                        headers:
                          payload === undefined ? {} : { "content-type": "application/json" },
                      })
                    }),
                }),
              )
            },
          ]),
        ),
        events: (event: EventClass, feedOptions?: FeedOptions) =>
          Stream.toAsyncIterable(
            feedStream({
              event,
              options: feedOptions ?? {},
              open: (cursor, signal) =>
                openEvents(
                  path("events").pipe(
                    Effect.map(
                      (events) => `${events}?${new URLSearchParams({ event: event.identifier })}`,
                    ),
                  ),
                  signal,
                  { headers: cursor === undefined ? {} : { "last-event-id": cursor } },
                ),
            }),
          ),
        ref: { actor: definition.name, id },
        state: {
          get current() {
            return store.state
          },
          get pending() {
            return store.pending
          },
          subscribe: (listener: (state: StateValue | undefined) => void) =>
            store.subscribe(listener),
          reconcile: (committed: StateValue) => store.reconcile(committed),
        },
      }

      handles.set(id, created)
      stores.set(id, store)

      if (handles.size > HANDLE_LIMIT)
        for (const key of handles.keys())
          if (key !== id && stores.get(key)?.isIdle === true) {
            handles.delete(key)
            stores.delete(key)
            break
          }

      return created
    }

    const keyed = (id: string) =>
      handle(
        id,
        definition.encodeId(id).pipe(
          Effect.map((encoded) => `/${encodeURIComponent(encoded)}`),
          Effect.mapError(invalid),
        ),
      )

    const client = {
      offline: queue,
      commandId: mintCommandId,
      get:
        definition.key === "singleton"
          ? () => handle("singleton", Effect.succeed(""))
          : (id: string) => keyed(id),
      create: definition.key === "minted" ? () => keyed(Effect.runSync(uuid(7))) : undefined,
    }

    return client as Client
  }
