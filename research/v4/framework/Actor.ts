/**
 * Durable Actors — proposed public surface (typecheck-only sketch, rc.116).
 *
 * Everything here compiles down to Effect primitives:
 *   Actor.command / Actor.query  →  Rpc.make
 *   Actor.make                   →  RpcGroup.make + Entity.fromRpcGroup
 *   Actor.toLayer                →  Entity.toLayer (concurrency: 1, maxIdleTime, mailboxCapacity, defectRetryPolicy)
 *   Counter.get(id)              →  Sharding.makeClient(entity)(id), wrapped so methods are plain Effects
 *   ctx.emit / .send / .after    →  rows in actor_events / actor_outbox inside the turn transaction
 *
 * The wrapping exists to add the contracts the framework promises:
 *   - one transaction per command ("turn"), generation fence, receipts (exactly-once per commandId)
 *   - typed events, typed timers, typed errors on every channel (no `unknown`/`any` leaks)
 *   - retryable conditions are defects (Cluster redelivers), never typed replies
 *
 * `Drizzle` is a placeholder for `EffectPgDatabase` (drizzle-orm/effect-postgres) so this file
 * typechecks from the repo root, where only `effect` is hoisted.
 */
import { Context, DateTime, Duration, Effect, Layer, Schedule, Schema, Scope, Stream } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { ClusterSchema, Entity, EntityAddress, Sharding } from "effect/unstable/cluster"
import { AlreadyProcessingMessage, EntityNotAssignedToRunner, MailboxFull, PersistenceError } from "effect/unstable/cluster/ClusterError"
import type { SqlClient } from "effect/unstable/sql/SqlClient"


/** Same commandId, different payload: the receipt does not match. Added to every command's E. */
export class CommandConflict extends Schema.TaggedError<CommandConflict>()("CommandConflict", {
  commandId: Schema.String
}, { httpApiStatus: 409 }) {}

/** Cluster could not deliver. `cause` keeps the original Cluster error; nothing is erased. */
export class ActorUnavailable extends Schema.TaggedError<ActorUnavailable>()("ActorUnavailable", {
  reason: Schema.Literals(["mailbox_full", "already_processing", "persistence", "not_assigned"]),
  cause: Schema.Union([MailboxFull, AlreadyProcessingMessage, PersistenceError, EntityNotAssignedToRunner])
}, { httpApiStatus: 503 }) {}


/** Placeholder for `EffectPgDatabase` from `drizzle-orm/effect-postgres` (built on the same PgClient). */
export interface Drizzle {
  readonly _: "drizzle-orm/effect-postgres EffectPgDatabase"
}
/** Nominal service: `PgClient` structurally extends `SqlClient`, so we never key on either directly. */
export class Database extends Context.Service<Database, {
  readonly sql: SqlClient
  readonly drizzle: Drizzle
}>()("durable-actors/Database") {}

export interface Caller {
  readonly userId: string
}


export interface Command<Tag extends string, In extends Schema.Top | undefined, Out extends Schema.Top, Errors extends ReadonlyArray<Schema.Top>> {
  readonly _kind: "command"
  readonly tag: Tag
  readonly input: In
  readonly output: Out
  readonly errors: Errors
}
export interface QueryDef<Tag extends string, In extends Schema.Top | undefined, Out extends Schema.Top, Errors extends ReadonlyArray<Schema.Top>> {
  readonly _kind: "query"
  readonly tag: Tag
  readonly input: In
  readonly output: Out
  readonly errors: Errors
}
export type AnyCommand = Command<string, any, any, any>
export type AnyQuery = QueryDef<string, any, any, any>
export type AnyEvent = Schema.Top & { readonly Type: { readonly _tag: string } }

/** `input` may be a schema (positional arg), struct fields (object arg), or omitted (no arg). */
type NormalizeInput<In> = In extends Schema.Top ? In : In extends Schema.Struct.Fields ? Schema.Struct<In> : undefined
const normalizeInput = (input: unknown): Schema.Top | undefined =>
  input === undefined ? undefined : Schema.isSchema(input) ? input : Schema.Struct(input as Schema.Struct.Fields)

interface Definition<In, Out, Errors> {
  readonly input?: In
  readonly output?: Out
  readonly errors?: Errors
}

export const command = <
  const Tag extends string,
  In extends Schema.Top | Schema.Struct.Fields | undefined = undefined,
  Out extends Schema.Top = typeof Schema.Void,
  const Errors extends ReadonlyArray<Schema.Top> = []
>(tag: Tag, def?: Definition<In, Out, Errors>): Command<Tag, NormalizeInput<In>, Out, Errors> => ({
  _kind: "command",
  tag,
  input: normalizeInput(def?.input) as NormalizeInput<In>,
  output: (def?.output ?? Schema.Void) as Out,
  errors: (def?.errors ?? []) as Errors
})

export const query = <
  const Tag extends string,
  In extends Schema.Top | Schema.Struct.Fields | undefined = undefined,
  Out extends Schema.Top = typeof Schema.Void,
  const Errors extends ReadonlyArray<Schema.Top> = []
>(tag: Tag, def?: Definition<In, Out, Errors>): QueryDef<Tag, NormalizeInput<In>, Out, Errors> => ({
  _kind: "query",
  tag,
  input: normalizeInput(def?.input) as NormalizeInput<In>,
  output: (def?.output ?? Schema.Void) as Out,
  errors: (def?.errors ?? []) as Errors
})


export type Policy =
  | { readonly _tag: "Hibernate"; readonly after: Duration.Input } // Entity.toLayer maxIdleTime
  | { readonly _tag: "MailboxCapacity"; readonly size: number | "unbounded" } // Entity.toLayer mailboxCapacity
  | { readonly _tag: "DefectRetry"; readonly schedule: Schedule.Schedule<any, unknown> } // Entity.toLayer defectRetryPolicy
  | { readonly _tag: "CommandTimeout"; readonly after: Duration.Input } // turn(): handler timeout → defect → redelivery
  | { readonly _tag: "LockWait"; readonly after: Duration.Input } // turn(): SET LOCAL lock_timeout on the generation fence
  | { readonly _tag: "ReceiptsRetention"; readonly keep: Duration.Input } // actor_receipts purge (never before cluster_messages)
  | { readonly _tag: "EventsRetention"; readonly keep: Duration.Input | "forever" } // actor_events purge

export const Hibernate = {
  after: (after: Duration.Input): Policy => ({ _tag: "Hibernate", after })
}
export const Mailbox = {
  capacity: (size: number | "unbounded"): Policy => ({ _tag: "MailboxCapacity", size })
}
export const Defects = {
  retry: (schedule: Schedule.Schedule<any, unknown>): Policy => ({ _tag: "DefectRetry", schedule })
}
export const Commands = {
  timeout: (after: Duration.Input): Policy => ({ _tag: "CommandTimeout", after }),
  lockWait: (after: Duration.Input): Policy => ({ _tag: "LockWait", after })
}
export const Receipts = {
  keep: (keep: Duration.Input): Policy => ({ _tag: "ReceiptsRetention", keep })
}
export const Events = {
  keep: (keep: Duration.Input | "forever"): Policy => ({ _tag: "EventsRetention", keep })
}


export interface CommandContext<Ev extends AnyEvent, Self> {
  readonly address: EntityAddress.EntityAddress
  readonly id: string
  /** framework-generated (or caller-supplied via CallOptions); receipts key on it */
  readonly commandId: string
  readonly tenantId: string
  readonly caller: Caller
  readonly now: DateTime.Utc
  /** joined to the turn transaction */
  readonly db: Drizzle
  /** this actor's own handle; `.send/.after/.at` become durable intents in the same transaction */
  readonly self: Self
  /** typed to the actor's declared `events` */
  readonly emit: (event: Ev["Type"]) => Effect.Effect<void>
}
/** Ambient service present only inside a command handler; `.send/.after/.at` require it. */
export class Turn extends Context.Service<Turn, CommandContext<any, any>>()("durable-actors/Turn") {}

export interface QueryContext {
  readonly address: EntityAddress.EntityAddress
  readonly id: string
  readonly tenantId: string
  readonly caller: Caller
  readonly db: Drizzle
}
export class Query extends Context.Service<Query, QueryContext>()("durable-actors/Query") {}


type Args<C> = C extends { readonly input: infer I } ? (I extends Schema.Top ? [input: I["Type"]] : []) : []
type OutOf<C> = C extends { readonly output: infer O extends Schema.Top } ? O["Type"] : never
type ErrOf<C> = C extends { readonly errors: infer Er extends ReadonlyArray<Schema.Top> } ? Er[number]["Type"] : never
type ErrorSchemaOf<Er extends ReadonlyArray<Schema.Top>> = Er extends readonly [] ? typeof Schema.Never : Schema.Union<Er>

export interface CallOptions {
  /** idempotency key; generated by the framework when omitted */
  readonly commandId?: string
}

export interface CommandMethod<C> {
  /** request/reply from outside a turn */
  (...args: [...Args<C>, options?: CallOptions]): Effect.Effect<OutOf<C>, ErrOf<C> | CommandConflict | ActorUnavailable>
  /** durable intent, committed with the current turn; commandId derived from (turn commandId, intent index) */
  readonly send: (...args: Args<C>) => Effect.Effect<void, never, Turn>
  readonly after: (delay: Duration.Input, ...args: Args<C>) => Effect.Effect<void, never, Turn>
  readonly at: (when: DateTime.Utc, ...args: Args<C>) => Effect.Effect<void, never, Turn>
}
export interface QueryMethod<Q> {
  (...args: Args<Q>): Effect.Effect<OutOf<Q>, ErrOf<Q> | ActorUnavailable>
}

export type Handle<Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ev extends AnyEvent> =
  & { readonly id: string; readonly address: EntityAddress.EntityAddress }
  & { readonly [C in Cs[number] as C["tag"]]: CommandMethod<C> }
  & { readonly [Q in Qs[number] as Q["tag"]]: QueryMethod<Q> }
  & { readonly events: <E extends Ev>(event: E) => Stream.Stream<E["Type"], never, Scope.Scope> }

export type HandlersFor<Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ev extends AnyEvent, Self, R> =
  & { readonly [C in Cs[number] as C["tag"]]: (ctx: CommandContext<Ev, Self>, ...args: Args<C>) => Effect.Effect<OutOf<C>, ErrOf<C>, R> }
  & { readonly [Q in Qs[number] as Q["tag"]]: (ctx: QueryContext, ...args: Args<Q>) => Effect.Effect<OutOf<Q>, ErrOf<Q>, R> }

type RpcOfDef<D> = D extends Command<infer T, infer I, infer O, infer Er>
  ? Rpc.Rpc<T, I extends Schema.Top ? I : typeof Schema.Void, O, ErrorSchemaOf<Er>>
  : D extends QueryDef<infer T, infer I, infer O, infer Er>
    ? Rpc.Rpc<T, I extends Schema.Top ? I : typeof Schema.Void, O, ErrorSchemaOf<Er>>
    : never
export type RpcsOf<Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>> = Extract<RpcOfDef<Cs[number] | Qs[number]>, Rpc.Any>


export interface ActorDefinition<Name extends string, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ev extends AnyEvent> {
  readonly name: Name
  readonly commands: Cs
  readonly queries: Qs
  readonly events: ReadonlyArray<Ev>
  readonly lifecycle: ReadonlyArray<Policy>
  /** `const counter = yield* Counter.get(id)` — resolves the runtime once; methods are then plain Effects. */
  readonly get: (id: string) => Effect.Effect<Handle<Cs, Qs, Ev>, never, Actors>
  /** Lives in the server file. Handlers may be an object or an Effect that acquires services once per activation. */
  readonly toLayer: {
    <R>(handlers: HandlersFor<Cs, Qs, Ev, Handle<Cs, Qs, Ev>, R>): Layer.Layer<never, never, Exclude<R, Turn | Query> | Actors>
    <R, RX>(build: Effect.Effect<HandlersFor<Cs, Qs, Ev, Handle<Cs, Qs, Ev>, R>, never, RX>): Layer.Layer<never, never, Exclude<R | RX, Scope.Scope | Turn | Query> | Actors>
  }
  /** identity with contextual typing, for handlers returned from an Effect */
  readonly of: <R>(handlers: HandlersFor<Cs, Qs, Ev, Handle<Cs, Qs, Ev>, R>) => HandlersFor<Cs, Qs, Ev, Handle<Cs, Qs, Ev>, R>
  /** escape hatches: the Effect primitives underneath */
  readonly rpcs: RpcGroup.RpcGroup<RpcsOf<Cs, Qs>>
  readonly entity: Entity.Entity<Name, RpcsOf<Cs, Qs>>
}
export type HandleOf<A> = A extends ActorDefinition<any, infer Cs, infer Qs, infer Ev> ? Handle<Cs, Qs, Ev> : never

/** The runtime. `actors.get(Counter, id)` is the non-sugared form of `Counter.get(id)`. */
export class Actors extends Context.Service<Actors, {
  readonly get: <Name extends string, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ev extends AnyEvent>(
    actor: ActorDefinition<Name, Cs, Qs, Ev>,
    id: string
  ) => Handle<Cs, Qs, Ev>
  readonly sharding: Sharding.Sharding["Service"]
  readonly database: Database["Service"]
}>()("durable-actors/Actors") {}

export const make = <
  const Name extends string,
  const Cs extends ReadonlyArray<AnyCommand>,
  const Qs extends ReadonlyArray<AnyQuery> = [],
  const Ev extends AnyEvent = never
>(
  name: Name,
  def: {
    readonly commands: Cs
    readonly queries?: Qs
    readonly events?: ReadonlyArray<Ev>
    readonly lifecycle?: ReadonlyArray<Policy>
  }
): ActorDefinition<Name, Cs, Qs, Ev> => {
  const all: ReadonlyArray<AnyCommand | AnyQuery> = [...def.commands, ...(def.queries ?? [])]
  const lifecycle = def.lifecycle ?? []
  const policy = <T extends Policy["_tag"]>(tag: T) => lifecycle.find((p): p is Extract<Policy, { _tag: T }> => p._tag === tag)

  const rpcs = RpcGroup.make(
    ...all.map((d) =>
      Rpc.make(d.tag, {
        payload: d.input ?? Schema.Void,
        success: d.output,
        error: d.errors.length === 0 ? Schema.Never : Schema.Union(d.errors)
      })
    )
  ).annotateRpcs(ClusterSchema.Persisted, true) as any
  const entity = Entity.fromRpcGroup(name, rpcs) as any

  const self: ActorDefinition<Name, Cs, Qs, Ev> = {
    name,
    commands: def.commands,
    queries: (def.queries ?? []) as unknown as Qs,
    events: def.events ?? [],
    lifecycle,
    get: (id) => Effect.map(Actors, (actors) => actors.get(self, id)),
    toLayer: ((build: unknown) =>
      entity
        .toLayer(
          Effect.gen(function*() {
            const address = yield* Entity.CurrentAddress
            const handlers: Record<string, (...args: Array<any>) => Effect.Effect<any, any, any>> = Effect.isEffect(build)
              ? yield* (build as Effect.Effect<any>)
              : build
            const wired: Record<string, (env: any) => Effect.Effect<any, any, any>> = {}
            for (const d of all) {
              wired[d.tag] = d._kind === "command"
                ? (env) => turn(address, env, lifecycle, (ctx) => handlers[d.tag]!(ctx, env.payload))
                : (env) => queryTurn(address, env, (ctx) => handlers[d.tag]!(ctx, env.payload))
            }
            return wired
          }),
          {
            concurrency: 1,
            maxIdleTime: policy("Hibernate")?.after ?? Duration.minutes(1),
            mailboxCapacity: policy("MailboxCapacity")?.size,
            defectRetryPolicy: policy("DefectRetry")?.schedule
          }
        )
        .pipe(Layer.provide(Layer.effect(Sharding.Sharding, Effect.map(Actors, (a) => a.sharding))))) as any,
    of: (handlers) => handlers,
    rpcs,
    entity
  }
  return self
}

/**
 * One transaction per command. Not implemented here; see README "Turn".
 * BEGIN → SELECT actor_generations … FOR UPDATE → receipt lookup → handler → events/outbox/receipt → COMMIT → NOTIFY.
 * Retryable conditions (stale generation, lock timeout, commit-unknown, CommandTimeout) are defects.
 */
declare const turn: <A, E, R>(
  address: EntityAddress.EntityAddress,
  envelope: unknown,
  lifecycle: ReadonlyArray<Policy>,
  body: (ctx: CommandContext<any, any>) => Effect.Effect<A, E, R>
) => Effect.Effect<A, E | CommandConflict, Exclude<R, Turn> | Actors>

/** Read-only; no fence, no receipt, no tx. */
declare const queryTurn: <A, E, R>(
  address: EntityAddress.EntityAddress,
  envelope: unknown,
  body: (ctx: QueryContext) => Effect.Effect<A, E, R>
) => Effect.Effect<A, E, Exclude<R, Query> | Actors>

/** Runtime layer: one per process. Provides `Actors` from the shared Database and Cluster Sharding. */
export const layer: Layer.Layer<Actors, never, Database | Sharding.Sharding> = Layer.effect(
  Actors,
  Effect.gen(function*() {
    const sharding = yield* Sharding.Sharding
    const database = yield* Database
    return Actors.of({ get: (actor, id) => makeHandle(sharding, actor, id), sharding, database })
  })
)
declare const makeHandle: <Name extends string, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ev extends AnyEvent>(
  sharding: Sharding.Sharding["Service"],
  actor: ActorDefinition<Name, Cs, Qs, Ev>,
  id: string
) => Handle<Cs, Qs, Ev>

export const Actor = { make, command, query, layer }
