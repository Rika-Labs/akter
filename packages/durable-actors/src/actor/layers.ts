import { Context, Effect, Layer, Predicate, Scope } from "effect"
import { CurrentCaller, System, Tenant } from "../identity/caller.ts"
import { payloadChain } from "../members/payload.ts"
import { InternalActors } from "../runtime/actors.ts"
import type { RegisteredConnection, RegisteredStream, Registration } from "../runtime/members.ts"
import type { ConnectionEntry } from "./connections.ts"
import { connectionOf } from "./connections.ts"
import type { Descriptor } from "./descriptor.ts"
import { jobsOf } from "./jobs.ts"
import { queriesOf, streamOf } from "./reads.ts"
import { turnsOf } from "./turns.ts"
import { workflowsOf } from "./workflows.ts"

/** The per-actor phase services `Actor.make` creates, which the adapters provide. */
export interface PhaseServices {
  readonly Turn: Context.Key<unknown, unknown>
  readonly Read: Context.Key<unknown, unknown>
  readonly Connection: Context.Key<unknown, unknown>
  readonly Workflow: Context.Key<unknown, unknown>
  readonly Executor: Context.Key<unknown, unknown>
}

type Entries = Readonly<Record<string, unknown>>

/** A layer builder: the entries themselves, or an Effect that builds them. */
export type Build = Entries | Effect.Effect<Entries, unknown, never>

const built = (build: Build): Effect.Effect<Entries, unknown> =>
  Effect.isEffect(build) ? build : Effect.succeed(build)

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
  handlers: Entries,
  services: Context.Context<never>,
) =>
  Effect.gen(function* () {
    const connections = new Map<string, RegisteredConnection>()

    for (const member of descriptor.connections) {
      const entry = handlers[member.tag] as Partial<ConnectionEntry> | undefined

      if (
        entry === undefined ||
        !Predicate.isFunction(entry.open) ||
        !Predicate.isFunction(entry.frame)
      )
        return yield* Effect.die(new Error(`Missing connection handlers ${member.tag}`))

      connections.set(
        member.tag,
        connectionOf(descriptor, phases.Connection, member, entry as ConnectionEntry, services),
      )
    }

    return connections
  })

const streamsOf = (
  descriptor: Descriptor,
  phases: PhaseServices,
  handlers: Entries,
  services: Context.Context<never>,
  actors: InternalActors["Service"],
) =>
  Effect.gen(function* () {
    const streams = new Map<string, RegisteredStream>()

    for (const member of descriptor.streams) {
      const handle = handlers[member.tag]

      if (!Predicate.isFunction(handle))
        return yield* Effect.die(new Error(`Missing stream handler ${member.tag}`))

      streams.set(
        member.tag,
        streamOf(descriptor, phases.Read, member, handle as never, services, actors),
      )
    }

    return streams
  })

/**
 * The owner of an ordinary actor's handlers: the builder runs once, when the
 * layer is built, and every activation on this runner shares its handlers. A
 * builder failure fails the layer. Workflow bodies receive the layer's context
 * without its `Scope`: a body's scope is its run's.
 */
const ordinaryOwner = (descriptor: Descriptor, phases: PhaseServices, build: Build) =>
  Effect.gen(function* () {
    const actors = yield* InternalActors
    const registration = registrationOf(descriptor, yield* Tenant)
    const handlers = yield* built(build)
    const services = yield* Effect.context<never>()
    const connections = yield* connectionsOf(descriptor, phases, handlers, services)
    const streams = yield* streamsOf(descriptor, phases, handlers, services, actors)
    const commands = yield* turnsOf(descriptor, phases.Turn, handlers as never, services, actors)

    return yield* actors.register({
      ...registration,
      workflows: yield* workflowsOf(
        descriptor,
        phases.Workflow,
        handlers as never,
        Context.omit(Scope.Scope)(services) as Context.Context<never>,
      ),
      activate: () => Effect.succeed(commands),
      connections,
      streams,
    } satisfies Registration)
  })

/**
 * The owner of a singleton's handlers: the builder runs once per activation,
 * in the activation's scope, as the actor with a `System({ source: "actor" })`
 * caller, so a fiber it forks with `Effect.forkScoped` lives exactly as long
 * as the one cluster-wide activation. A builder failure fails that activation,
 * whose queued commands then fail, rather than the layer.
 */
const singletonOwner = (descriptor: Descriptor, phases: PhaseServices, build: Build) =>
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

    const services = yield* Effect.context<never>()

    if (descriptor.workflows.length > 0)
      return yield* Effect.die(
        new Error(`Singleton actor ${descriptor.name} cannot declare workflows`),
      )

    yield* actors.register({
      ...registration,
      workflows: new Map(),
      activate: Effect.fnUntraced(function* (ref) {
        const scope = yield* Scope.Scope

        const handlers = yield* built(build).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(Tenant, ref.tenant),
          Effect.provideService(CurrentCaller, System.make({ source: "actor", ref })),
          Effect.provideContext(services),
        )

        return yield* turnsOf(descriptor, phases.Turn, handlers as never, services, actors)
      }),
      connections: new Map(),
      streams: new Map(),
    } satisfies Registration)
  })

/** Registers the handlers of every command, connection, stream, and workflow. */
export const handlerLayer = (descriptor: Descriptor, phases: PhaseServices, build: Build) =>
  Layer.effectDiscard(
    descriptor.singleton
      ? singletonOwner(descriptor, phases, build)
      : ordinaryOwner(descriptor, phases, build),
  )

/** Registers every query's handler; queries run on the caller's node. */
export const queryLayer = (descriptor: Descriptor, phases: PhaseServices, build: Build) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const actors = yield* InternalActors
      const handlers = yield* built(build)
      const services = yield* Effect.context<never>()

      yield* actors.registerQueries({
        name: descriptor.name,
        access: descriptor.access,
        placement: descriptor.placement,
        timeoutMs: descriptor.policy.executionMs,
        tables: descriptor.tables,
        blobs: descriptor.blobs,
        queries: yield* queriesOf(descriptor, phases.Read, handlers as never, services, actors),
        payloads: descriptor.payloads(false).filter((declared) => declared.kind === "event"),
      })
    }),
  )

/** Registers every job's executor; executors run after the enqueueing turn commits. */
export const jobLayer = (descriptor: Descriptor, phases: PhaseServices, build: Build) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const actors = yield* InternalActors
      const executors = yield* built(build)
      const services = yield* Effect.context<never>()

      yield* actors.registerEffects({
        name: descriptor.name,
        progress: descriptor.progressJobs,
        services,
        effects: yield* jobsOf(descriptor, phases.Executor, executors as never),
        payloads: descriptor.payloads(false).filter((declared) => declared.kind === "effect"),
      })
    }),
  )
