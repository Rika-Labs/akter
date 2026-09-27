import type { Effect, Option } from "effect"
import type { RetentionGap, UnknownCursor } from "../errors/events.ts"
import type { ActorRef, Caller, Principal } from "../identity/caller.ts"
import type { AnyConnection } from "../members/connection.ts"
import type { EventClass } from "../members/event.ts"
import type { EventEntry } from "./command.ts"

/** Narrows a broadcast: `to` keeps only these connections, `except` removes these. */
export interface BroadcastOptions {
  readonly to?: ReadonlyArray<string>
  readonly except?: ReadonlyArray<string>
}

/** One open connection of a member. `session` is present only when asked for. */
export interface ConnectionInfo<Session = unknown> {
  readonly connectionId: string
  readonly caller: Caller
  readonly session?: Session
}

/** The per-connection state a member declares with `session`, at most 16 KiB encoded. */
export interface SessionAccess<Session> {
  /** The session as last written, or none before the first `set`. */
  readonly get: Effect.Effect<Option.Option<Session>>
  /** Merges `patch` into the session; written once, fenced, after the handler returns. */
  readonly set: (patch: Partial<Session>) => Effect.Effect<void>
}

/** A frame, or an event entry whose cursor the client deduplicates on. */
export type FrameOf<Server> = Server | EventEntry<Server>

/**
 * The context of one connection handler, obtained with `yield* X.Connection`.
 * It reads committed state and sends frames; durable actor changes go through
 * commands.
 */
export interface ConnectionContext<State, Event extends EventClass, Server, Session> {
  readonly id: string
  readonly ref: ActorRef
  readonly connectionId: string
  readonly member: string
  /** The caller authorized when the connection opened, never frame content. */
  readonly caller: Caller
  readonly principal: Option.Option<Principal>
  /** The state the activation last committed. */
  readonly state: Readonly<State>
  /** The activation's flushed-through event cursor when the handler started. */
  readonly cursor: string
  /** True when this activation did not run the connection's `open`. */
  readonly resumed: boolean
  readonly session: SessionAccess<Session>
  /** Sends a frame to this connection once the handler returns. */
  readonly send: (frame: FrameOf<Server>) => Effect.Effect<void>
  /** Sends a frame to this member's open connections, parked or not, wherever they are held. */
  readonly broadcast: (frame: FrameOf<Server>, options?: BroadcastOptions) => Effect.Effect<void>
  /** At most 1,000 of this member's open connections; `session` only when asked for. */
  readonly connections: (options?: {
    readonly session?: boolean
  }) => Effect.Effect<ReadonlyArray<ConnectionInfo<Session>>>
  /** Closes this connection with `SessionEnded` cause `ServerClosed` once the handler returns. */
  readonly close: Effect.Effect<void>
  readonly events: <E extends Event>(
    event: E,
    options?: { readonly after?: string | undefined },
  ) => Effect.Effect<ReadonlyArray<EventEntry<E["Type"]>>, UnknownCursor | RetentionGap>
}

/** How a command turn reaches connections; frames go out only after the turn commits. */
export interface BroadcastContext<Connections extends AnyConnection = AnyConnection> {
  readonly broadcast: <C extends Connections>(
    member: C,
    frame: FrameOf<C["server"]["Type"]>,
    options?: BroadcastOptions,
  ) => Effect.Effect<void>
  /** At most 1,000 of the member's open connections, to filter into `to`. */
  readonly connections: <C extends Connections>(
    member: C,
  ) => Effect.Effect<ReadonlyArray<ConnectionInfo>>
}
