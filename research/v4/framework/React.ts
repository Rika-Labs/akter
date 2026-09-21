/**
 * React bindings — declared surface only (no React import, no implementation): what
 * `durable-actors/react` would ship on top of the Promise client (decision 131 / DX §6).
 *
 * Every hook is typed off `PromiseHandle`, so a component sees the same commands, queries,
 * streams and connections as a non-Effect caller, and the same thrown error classes.
 *
 * @since 0.1.0
 */
import type * as Schema from "effect/Schema"
import type {
  ActorDefinition,
  AnyBlob,
  AnyCommand,
  AnyConnection,
  AnyQuery,
  AnyStream,
  AnyTagged,
  ConnectionDef,
  EphemeralDefinition,
  Policy,
  PromiseConnection,
  PromiseHandle,
  QueryDef
} from "./Actor.ts"

/** What a data hook returns: the last value, the in-flight flag and the error, refreshed on re-render. */
export interface QueryResult<A> {
  readonly data: A | undefined
  readonly loading: boolean
  /** the thrown error class: a declared error, or `InvalidInput | Unauthorized | TransportError` */
  readonly error: unknown
  readonly refetch: () => void
}

/** The open socket plus the frames received so far; closed when the component unmounts. */
export interface ConnectionResult<Server, Client> {
  readonly connection: PromiseConnection<Server, Client> | undefined
  readonly frames: ReadonlyArray<Server>
  readonly error: unknown
}

/** `const chat = useActor(Chat, roomId)` — a memoized `PromiseHandle` bound to the id. */
export declare const useActor: {
  <Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Is extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Cn extends ReadonlyArray<AnyConnection>, Ev extends AnyTagged>(
    actor: ActorDefinition<string, Id, Cs, Is, Qs, Ss, Cn, Ev, AnyTagged, Schema.Struct.Fields, ReadonlyArray<AnyBlob>, ReadonlyArray<Policy<any>>, string | undefined>,
    id: Id["Type"]
  ): PromiseHandle<Id, Cs, Is, Qs, Ss, Cn, Ev>
  <Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Is extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Cn extends ReadonlyArray<AnyConnection>>(
    actor: EphemeralDefinition<string, Id, Cs, Is, Qs, Ss, Cn, Schema.Struct.Fields, ReadonlyArray<any>, string | undefined>,
    id: Id["Type"]
  ): PromiseHandle<Id, Cs, Is, Qs, Ss, Cn, never>
}

/** `const recent = useQuery(chat, Recent, { limit: 20 })` — the query runs on the caller's node, so it never wakes the actor. */
export declare const useQuery: <
  H extends { readonly id: unknown },
  Q extends QueryDef<string, any, Schema.Top, any, any>
>(
  handle: H,
  query: Q,
  ...args: Q["input"] extends Schema.Top ? [input: Q["input"]["Type"]] : []
) => QueryResult<Q["output"]["Type"]>

/** `const { frames } = useConnection(chat, Live, { since: 0 })` — opened on mount, closed on unmount. */
export declare const useConnection: <
  H extends { readonly id: unknown },
  N extends ConnectionDef<string, any, Schema.Top, Schema.Top, any, any, any>
>(
  handle: H,
  connection: N,
  ...args: N["params"] extends Schema.Top ? [params: N["params"]["Type"]] : []
) => ConnectionResult<N["server"]["Type"], N["client"]["Type"]>
