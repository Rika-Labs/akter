import { Context, Effect, Option, Schema } from "effect"
import type { BroadcastOptions, ConnectionContext } from "../contexts/connection.ts"
import { SessionEnded } from "../errors/actor.ts"
import { CurrentCaller, principal, Tenant } from "../identity/caller.ts"
import { CurrentConnectionCommands, connectionCommandId } from "../identity/connection.ts"
import type { AnyConnection } from "../members/connection.ts"
import {
  type Broadcast,
  ConnectionPhase,
  type ConnectionResult,
  type RegisteredConnection,
} from "../runtime/members.ts"
import type { Decoded, Failure, StateValue } from "./codecs.ts"
import type { Descriptor } from "./descriptor.ts"
import { eventsWith } from "./reads.ts"

const decodeCloseReason = Schema.decodeUnknownEffect(SessionEnded.fields.cause)

const isEventEntry = Schema.is(
  Schema.Struct({
    cursor: Schema.String,
    event: Schema.Unknown,
    commandId: Schema.String,
    timestamp: Schema.DateTimeUtc,
  }),
)

/** The handlers of one connection member, as `X.toLayer` receives them. */
export interface ConnectionEntry {
  readonly open: (payload: Decoded) => Effect.Effect<void, Failure>
  readonly frame: (frame: Decoded) => Effect.Effect<void>
  readonly close?: ((reason: SessionEnded["cause"]) => Effect.Effect<void>) | undefined
  readonly resync?:
    | ((input: { readonly after: string | undefined }) => Effect.Effect<void>)
    | undefined
}

/**
 * A server frame as the runtime sends it. A frame that is an event entry and
 * encodes as the member's server schema carries its cursor, which the client
 * deduplicates on.
 */
const encodeFrame = (descriptor: Descriptor, member: string, frame: Decoded) =>
  Effect.gen(function* () {
    const codec = descriptor.connectionCodecs.get(member)

    if (codec === undefined) return yield* Effect.die(new Error(`Undeclared connection ${member}`))

    if (isEventEntry(frame)) {
      const encoded = yield* codec.encodeServer({ value: frame.event }).pipe(Effect.option)

      if (Option.isSome(encoded)) return { frame: encoded.value, event: frame.cursor }
    }

    return { frame: yield* codec.encodeServer({ value: frame }).pipe(Effect.orDie) }
  })

/** `broadcast` for a turn or connection handler, collecting frames the runtime sends after commit. */
export const broadcastsTo =
  ({
    descriptor,
    broadcasts,
    guard,
  }: {
    readonly descriptor: Descriptor
    readonly broadcasts: Array<Broadcast>
    readonly guard: (capability: string) => Effect.Effect<void>
  }) =>
  (member: AnyConnection, frame: Decoded, options?: BroadcastOptions) =>
    Effect.gen(function* () {
      yield* guard("Broadcast")

      if (!descriptor.connections.includes(member))
        return yield* Effect.die(new Error(`Undeclared connection ${member.tag}`))

      broadcasts.push({
        member: member.tag,
        ...(yield* encodeFrame(descriptor, member.tag, frame)),
        to: options?.to,
        except: options?.except,
      })
    })

/**
 * One connection member's phase runner. Its capabilities die once the phase
 * handler returns; a resync cannot change the session, and a declared `open`
 * failure refuses the connection.
 */
export const connectionOf = ({
  descriptor,
  Connection,
  member,
  entry,
  services,
}: {
  readonly descriptor: Descriptor
  readonly Connection: Context.Key<object, object>
  readonly member: AnyConnection
  readonly entry: ConnectionEntry
  readonly services: Context.Context<never>
}): RegisteredConnection => {
  const codec = descriptor.connectionCodecs.get(member.tag)!
  const memberCodec = descriptor.codecs.get(member.tag)!

  return {
    stampCursor: member.stampCursor,
    progress:
      member.progress === undefined
        ? undefined
        : {
            jobs: new Set(member.progress.jobs.map((job) => job.tag)),
            to: member.progress.to,
          },
    hasResync: entry.resync !== undefined,
    run: Effect.fnUntraced(function* (input, phase) {
      let open = true
      const { state } = yield* descriptor.state.decodeStored(input.state)

      let session: StateValue | undefined =
        input.session === undefined || codec.decodeSession === undefined
          ? undefined
          : ((yield* codec.decodeSession(input.session).pipe(Effect.orDie)).value as StateValue)

      let changed = false
      let close = false
      const sends: Array<{ readonly frame: string; readonly event?: string | undefined }> = []
      const broadcasts: Array<Broadcast> = []

      const guard = (capability: string) =>
        open
          ? Effect.void
          : Effect.die(new Error(`${capability} capability escaped its connection handler`))

      const set = Effect.fnUntraced(function* (patch: StateValue) {
        yield* guard("Session")

        if (codec.encodeSession === undefined || codec.decodeSession === undefined)
          return yield* Effect.die(new Error(`Connection ${member.tag} declares no session`))

        if (ConnectionPhase.guards.Resync(phase))
          return yield* Effect.die(new Error("A resync handler cannot change the session"))

        const next = Object.assign({}, session, patch)
        const encoded = yield* codec.encodeSession({ value: next }).pipe(Effect.orDie)
        session = (yield* codec.decodeSession(encoded).pipe(Effect.orDie)).value as StateValue
        changed = true
      })

      let calls = 0
      const commands = input.commands

      const commandIds =
        commands === undefined
          ? undefined
          : (target: string, command: string) =>
              connectionCommandId({ commands, index: calls++, target, command })

      const context: ConnectionContext<StateValue, never, Decoded, StateValue> = {
        id: input.ref.id,
        ref: input.ref,
        connectionId: input.connectionId,
        member: input.member,
        caller: input.caller,
        principal: principal(input.caller),
        state: Object.freeze(state),
        cursor: input.cursor,
        resumed: input.resumed,
        session: {
          get: Effect.sync(() => Option.fromUndefinedOr(session)),
          set,
        },
        send: Effect.fnUntraced(function* (frame: Decoded) {
          yield* guard("Send")
          sends.push(yield* encodeFrame(descriptor, member.tag, frame))
        }),
        broadcast: (frame, options) =>
          broadcastsTo({ descriptor, broadcasts, guard })(member, frame, options),
        connections: (options) =>
          Effect.gen(function* () {
            yield* guard("Connections")

            return yield* Effect.forEach(yield* input.connections(member.tag), (open) =>
              Effect.gen(function* () {
                if (
                  options?.session !== true ||
                  open.session === undefined ||
                  codec.decodeSession === undefined
                )
                  return { connectionId: open.connectionId, caller: open.caller }

                return {
                  connectionId: open.connectionId,
                  caller: open.caller,
                  session: (yield* codec.decodeSession(open.session).pipe(Effect.orDie))
                    .value as StateValue,
                }
              }),
            )
          }),
        close: Effect.suspend(() => {
          close = true

          return guard("Close")
        }),
        events: ((event, options) =>
          Effect.flatMap(guard("Events"), () =>
            eventsWith({ descriptor, readEvents: input.events, label: "events" })(event, options),
          )) as ConnectionContext<StateValue, never, Decoded, StateValue>["events"],
      }

      const program = ConnectionPhase.match(phase, {
        Open: ({ params }) =>
          Effect.flatMap(memberCodec.decodePayload(params).pipe(Effect.orDie), ({ value }) =>
            entry.open(value),
          ).pipe(
            Effect.catch((error) =>
              memberCodec.isError(error)
                ? Effect.flatMap(memberCodec.encodeError(error).pipe(Effect.orDie), (failure) =>
                    Effect.fail({ failure }),
                  )
                : Effect.die(error),
            ),
          ),
        Frame: ({ frame }) =>
          Effect.flatMap(codec.decodeClient(frame).pipe(Effect.orDie), ({ value }) =>
            entry.frame(value),
          ),
        Close: ({ reason }) =>
          Effect.flatMap(
            decodeCloseReason(reason).pipe(Effect.orDie),
            (cause) => entry.close?.(cause) ?? Effect.void,
          ),
        Resync: ({ after }) => entry.resync?.({ after }) ?? Effect.void,
      })

      return yield* program.pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const encoded =
              !changed || codec.encodeSession === undefined
                ? input.session
                : yield* codec.encodeSession({ value: session }).pipe(Effect.orDie)

            const result: ConnectionResult = { session: encoded, changed, sends, broadcasts, close }

            return result
          }),
        ),
        Effect.ensuring(Effect.sync(() => (open = false))),
        Effect.provideService(CurrentCaller, input.caller),
        Effect.provideService(Tenant, input.ref.tenant),
        Effect.provideContext(Context.add(services, Connection, context)),
        Effect.provideService(CurrentConnectionCommands, commandIds),
      )
    }),
  }
}
