import { Context, Effect, Layer, Predicate, Scope } from "effect"
import { CurrentCaller, System, Tenant } from "../identity/caller.ts"
import { payloadChain } from "../members/payload.ts"
import { InternalActors } from "../runtime/actors.ts"
import type { RegisteredConnection, RegisteredStream, Registration } from "../runtime/members.ts"
import type { Handler, StreamHandler } from "./codecs.ts"
import { type ConnectionEntry, connectionOf } from "./connections.ts"
import type { Descriptor } from "./descriptor.ts"
import { jobsOf } from "./jobs.ts"
import { queriesOf, streamOf } from "./reads.ts"
import { turnsOf } from "./turns.ts"
import { workflowsOf } from "./workflows.ts"

/** The per-actor phase services `Actor.make` creates, which the adapters provide. */
export interface PhaseServices {
  readonly Turn: Context.Key<object, object>
  readonly Read: Context.Key<object, object>
  readonly Connection: Context.Key<object, object>
  readonly Workflow: Context.Key<object, object>
  readonly Executor: Context.Key<object, object>
}

/** One layer's handlers, stream handlers, connection entries, and executors, by member tag. */
type Entries = Readonly<Record<string, Handler | StreamHandler | ConnectionEntry>>

/**
 * What a layer constructor receives: the descriptor, its phase services, the
 * entries or an Effect that builds them, and the Effect that captures the
 * services the entries require when the layer is built.
 */
export interface LayerOptions<H extends object, E, RB, RS> {
  readonly descriptor: Descriptor
  readonly phases: PhaseServices
  readonly build: H | Effect.Effect<H, E, RB>
  readonly services: Effect.Effect<Context.Context<RS>, never, RS>
}

/** The entries themselves, or what the builder builds. */
const built = <H extends object, E, RB>(build: H | Effect.Effect<H, E, RB>) =>
  (Effect.isEffect(build) ? build : Effect.succeed(build)) as Effect.Effect<H, E, RB>

/** The layer's entries as the adapters read them: by tag, with member types erased. */
const erased = <H extends object>(entries: H) => entries as Entries

const registrationOf = (descriptor: Descriptor, tenant: string) => ({
  name: descriptor.name,
  singleton: descriptor.singleton,
  mintable: descriptor.mintable,
  watches: descriptor.watches,
  tenant,
  access: descriptor.access,
  placement: descriptor.placement,
  policy: descriptor.policy,
  tables: descriptor.tables,
  blobs: descriptor.blobs,
  cron: descriptor.cron,
  subscriptions: descriptor.registeredSubscriptions,
  subscribers: descriptor.policy.subscribers,
  payloads: [
    ...descriptor.payloads(true),
    ...descriptor.subscriptions.flatMap((declared) =>
      declared.events.map((event) => ({
        actorType: declared.source.name,
        kind: "event" as const,
        tag: event.identifier,
        chain: payloadChain(event),
        writes: false,
      })),
    ),
  ],
  upcastEvent: (tag: string, version: number, value: string) => {
    const codec = descriptor.eventCodecs.get(tag)

    return codec === undefined
      ? Effect.die(new Error(`Undeclared event: ${tag}`))
      : codec.upcast(value, version).pipe(Effect.orDie)
  },
  feeds: descriptor.feeds,
})

const connectionsOf = (
  descriptor: Descriptor,
  phases: PhaseServices,
  entries: Entries,
  services: Context.Context<never>,
) =>
  Effect.gen(function* () {
    const connections = new Map<string, RegisteredConnection>()

    for (const member of descriptor.connections) {
      const entry = entries[member.tag]

      if (
        entry === undefined ||
        !Predicate.hasProperty(entry, "open") ||
        !Predicate.isFunction(entry.open) ||
        !Predicate.isFunction(entry.frame)
      )
        return yield* Effect.die(new Error(`Missing connection handlers ${member.tag}`))

      connections.set(
        member.tag,
        connectionOf({ descriptor, Connection: phases.Connection, member, entry, services }),
      )
    }

    return connections
  })

const streamsOf = (
  descriptor: Descriptor,
  phases: PhaseServices,
  entries: Entries,
  services: Context.Context<never>,
  actors: InternalActors["Service"],
) =>
  Effect.gen(function* () {
    const streams = new Map<string, RegisteredStream>()

    for (const member of descriptor.streams) {
      const handle = entries[member.tag]

      if (!Predicate.isFunction(handle))
        return yield* Effect.die(new Error(`Missing stream handler ${member.tag}`))

      streams.set(
        member.tag,
        streamOf({
          descriptor,
          Read: phases.Read,
          member,
          handle: handle as StreamHandler,
          services,
          actors,
        }),
      )
    }

    return streams
  })

const handlersOf = (entries: Entries) =>
  Object.fromEntries(
    Object.entries(entries).flatMap(([tag, entry]) =>
      Predicate.isFunction(entry) ? [[tag, entry as Handler] as const] : [],
    ),
  )

/**
 * The owner of an ordinary actor's handlers: the builder runs once, when the
 * layer is built, and every activation on this runner shares its handlers. A
 * builder failure fails the layer. Workflow bodies receive the layer's context
 * without its `Scope`: a body's scope is its run's.
 */
export const ordinaryLayer = <H extends object, E, RB, RS>({
  descriptor,
  phases,
  build,
  services: capture,
}: LayerOptions<H, E, RB, RS>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const actors = yield* InternalActors
      const registration = registrationOf(descriptor, yield* Tenant)
      const entries = erased(yield* built(build))
      const services = (yield* capture) as Context.Context<never>
      const connections = yield* connectionsOf(descriptor, phases, entries, services)
      const streams = yield* streamsOf(descriptor, phases, entries, services, actors)
      const handlers = handlersOf(entries)

      const commands = yield* turnsOf({
        descriptor,
        Turn: phases.Turn,
        handlers,
        services,
        actors,
      })

      const workflows = yield* workflowsOf({
        descriptor,
        Workflow: phases.Workflow,
        bodies: handlers,
        services: services.pipe(Context.omit(Scope.Scope)) as Context.Context<never>,
      })

      return yield* actors.register({
        ...registration,
        workflows,
        activate: () => Effect.succeed(commands),
        connections,
        streams,
      } satisfies Registration)
    }),
  )

/**
 * The owner of a singleton's handlers: the builder runs once per activation,
 * in the activation's scope, as the actor with a `System({ source: "actor" })`
 * caller, so a fiber it forks with `Effect.forkScoped` lives exactly as long
 * as the one cluster-wide activation. A builder failure fails that activation,
 * whose commands then fail, rather than the layer.
 */
export const singletonLayer = <H extends object, E, RB, RS>({
  descriptor,
  phases,
  build,
  services: capture,
}: LayerOptions<H, E, RB, RS>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const actors = yield* InternalActors
      const registration = registrationOf(descriptor, yield* Tenant)

      if (
        descriptor.connections.length > 0 ||
        descriptor.streams.length > 0 ||
        descriptor.feeds.size > 0 ||
        descriptor.watches.size > 0
      )
        return yield* Effect.die(
          new Error("Singleton actors cannot declare connections, streams, feeds, or watches yet"),
        )

      const services = (yield* capture) as Context.Context<never>
      const buildServices = yield* Effect.context<RB>()

      if (descriptor.workflows.length > 0)
        return yield* Effect.die(
          new Error(`Singleton actor ${descriptor.name} cannot declare workflows`),
        )

      yield* actors.register({
        ...registration,
        workflows: new Map(),
        activate: Effect.fnUntraced(function* (ref) {
          const scope = yield* Scope.Scope

          const entries = erased(
            yield* built(build).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.provideService(Tenant, ref.tenant),
              Effect.provideService(CurrentCaller, System.make({ source: "actor", ref })),
              Effect.provideContext(buildServices),
              Effect.orDie,
            ),
          )

          return yield* turnsOf({
            descriptor,
            Turn: phases.Turn,
            handlers: handlersOf(entries),
            services,
            actors,
          })
        }),
        connections: new Map(),
        streams: new Map(),
      } satisfies Registration)
    }),
  )

/** Registers every query's handler; queries run on the caller's node. */
export const queryLayer = <H extends object, E, RB, RS>({
  descriptor,
  phases,
  build,
  services: capture,
}: LayerOptions<H, E, RB, RS>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const actors = yield* InternalActors
      const handlers = handlersOf(erased(yield* built(build)))
      const services = (yield* capture) as Context.Context<never>

      yield* actors.registerQueries({
        name: descriptor.name,
        access: descriptor.access,
        placement: descriptor.placement,
        timeoutMs: descriptor.policy.executionMs,
        tables: descriptor.tables,
        blobs: descriptor.blobs,
        queries: yield* queriesOf({ descriptor, Read: phases.Read, handlers, services, actors }),
        payloads: descriptor.payloads(false).filter((declared) => declared.kind === "event"),
      })
    }),
  )

/** Registers every job's executor; executors run after the enqueueing turn commits. */
export const jobLayer = <H extends object, E, RB, RS>({
  descriptor,
  phases,
  build,
  services: capture,
}: LayerOptions<H, E, RB, RS>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const actors = yield* InternalActors
      const executors = handlersOf(erased(yield* built(build)))
      const services = (yield* capture) as Context.Context<never>

      yield* actors.registerJobs({
        name: descriptor.name,
        progress: descriptor.progressJobs,
        services,
        jobs: yield* jobsOf({ descriptor, Executor: phases.Executor, executors }),
        payloads: descriptor.payloads(false).filter((declared) => declared.kind === "job"),
      })
    }),
  )
