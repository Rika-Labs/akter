import { Effect, Predicate, Schema } from "effect"
import type { ActorRef, System } from "../identity/caller.ts"
import { handleOf } from "./handles.ts"
import type { Actors } from "../handles/actors.ts"
import type { InternalActors } from "../runtime/actors.ts"
import type { Access } from "../policies/access.ts"
import { childId, parseChildId } from "../identity/child.ts"
import { isMintedId } from "../identity/mint.ts"
import type { Placement } from "../runtime/storage/codec.ts"
import type { RegisteredSubscription } from "../runtime/members.ts"
import { SubscriptionFailure } from "../errors/subscription.ts"
import type { AnyCommand, AnyMember, MemberRecord, ValueSchema } from "../members/command.ts"
import type { AnyConnection } from "../members/connection.ts"
import type { AnyStream } from "../members/stream.ts"
import type { AnyReducer } from "../members/reducer.ts"
import { type AnyWorkflow, isWorkflow } from "../members/workflow.ts"
import type { AnySubscription } from "../members/subscription.ts"
import type { AnyJob, AnyJobBinding } from "../members/job.ts"
import { type AnyBlob, isBlob, isContent } from "../members/blob.ts"
import type { EventClass } from "../members/event.ts"
import {
  type PayloadDeclaration,
  type DefinitionPayloads,
  payloadChain,
  payloadCodec,
} from "../members/payload.ts"
import { type Policy, resolvePolicy, type TurnPolicy } from "../policies/command.ts"
import { type JobPolicy, resolveJobPolicy } from "../policies/job.ts"
import { type CronEntry, resolveSchedules } from "../policies/schedules.ts"
import { type AnyOwnedTable, ownership } from "../tables/owned.ts"
import { exitCodec } from "../runtime/workflows/steps.ts"
import { ActorStates, type ActorState } from "../state/migration.ts"
import {
  type MemberCodecs,
  memberCodecs,
  type StateCodec,
  stateCodec,
  valueCodec,
} from "./codecs.ts"
import {
  checkDeclaredErrors,
  type ServedDefinition,
  servedConnection,
  servedMember,
} from "./served.ts"

const SingletonKeySchema = Schema.TaggedStruct("Singleton", {})

/** Whether a definition's `key` is `Actor.singleton`. */
export const isSingletonKey = Schema.is(SingletonKeySchema)

/** Marker for a singleton actor's `key`: one instance per tenant, resolved with `X.get()`. */
export const singleton = SingletonKeySchema.make({})

/** The type of `Actor.singleton`, the `key` of a singleton actor. */
export type SingletonKey = typeof singleton

export type KeySchema = Schema.Codec<string, string>

/** How many levels below its actor-placed root a parent-placed actor may sit. */
const MAX_PLACEMENT_DEPTH = 4

const isUUIDv7 = Schema.is(Schema.String.check(Schema.isUUID(7)))

const NAME = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9]{0,79}$/u))

/** The declaration `Actor.make` compiles, before its type parameters are erased. */
export interface Declaration {
  readonly key?: KeySchema | SingletonKey | undefined
  readonly placement?: "tenant" | "actor" | { readonly parent: object } | undefined
  readonly state?: ActorState | undefined
  readonly events?: ReadonlyArray<EventClass> | undefined
  readonly feeds?: ReadonlyArray<EventClass> | undefined
  readonly tables?: ReadonlyArray<AnyOwnedTable> | undefined
  readonly blobs?: ReadonlyArray<AnyBlob> | undefined
  readonly api?: MemberRecord | undefined
  readonly internal?: MemberRecord | undefined
  readonly createdBy?: AnyCommand | undefined
  readonly schedules?: Readonly<Record<string, AnyCommand>> | undefined
  readonly jobs?: Readonly<Record<string, AnyJobBinding>> | undefined
  readonly policy?: Policy | undefined
  readonly access?: Access | undefined
  readonly subscriptions?: ReadonlyArray<AnySubscription> | undefined
}

/** One declared job of an actor: its schema, compiled payload codec, and resolved binding. */
export interface CompiledJob {
  readonly job: AnyJob
  readonly codec: ReturnType<typeof payloadCodec<AnyJob>>
  readonly policy: JobPolicy
}

/** A connection member's frame and session codecs. */
export interface ConnectionCodecs {
  readonly encodeServer: (value: {
    readonly value: unknown
  }) => Effect.Effect<string, Schema.SchemaError>
  readonly decodeClient: (
    text: string,
  ) => Effect.Effect<{ readonly value: unknown }, Schema.SchemaError>
  readonly encodeSession:
    | ((value: { readonly value: unknown }) => Effect.Effect<string, Schema.SchemaError>)
    | undefined
  readonly decodeSession:
    | ((text: string) => Effect.Effect<{ readonly value: unknown }, Schema.SchemaError>)
    | undefined
}

/** Runtime access to a definition's internal handle, for test harnesses. */
export interface InternalHandle {
  /**
   * A handle to actor `id` of `tenant` that calls as `caller` and reaches
   * `internal` commands; an `id` that fails the key schema is a defect.
   */
  readonly handle: (
    id: string,
    tenant: string,
    caller: typeof System.Type,
  ) => Effect.Effect<{ readonly ref: ActorRef }, never, Actors | InternalActors>
}

/**
 * Everything `Actor.make` derives from one declaration, compiled once and
 * frozen: validated members and their codecs, resolved policy, identity,
 * placement, jobs, subscriptions, and the served view. Every phase adapter,
 * handle, layer, and lookup reads it; it is process metadata, never durable
 * authority.
 */
export interface Descriptor {
  readonly name: string
  readonly access: Access | undefined
  readonly singleton: boolean
  /** Unkeyed with a creation command, so a turn may mint its ids. */
  readonly mintable: boolean
  /** True for an unkeyed actor that is not parent-placed, whose ids a client mints. */
  readonly minted: boolean
  readonly placement: Placement
  /** Levels below the actor-placed root; a root is 0. */
  readonly depth: number
  /** The definition this actor is placed on, when parent-placed. */
  readonly parent: Descriptor | undefined
  readonly idSchema: KeySchema
  readonly decodeId: (id: string) => Effect.Effect<string, Schema.SchemaError>
  readonly encodeId: (id: string) => Effect.Effect<string, Schema.SchemaError>
  readonly isId: (id: string) => boolean
  readonly childId: (parentId: string, local: string) => string
  readonly api: MemberRecord
  readonly internalCommands: MemberRecord
  /** `api` then `internal` members, in declaration order. */
  readonly members: ReadonlyArray<AnyMember>
  readonly commands: ReadonlyArray<AnyCommand>
  readonly queries: ReadonlyArray<AnyMember>
  readonly reducers: ReadonlyArray<AnyReducer>
  readonly connections: ReadonlyArray<AnyConnection>
  readonly streams: ReadonlyArray<AnyStream>
  readonly workflows: ReadonlyArray<AnyWorkflow>
  readonly internalMembers: ReadonlySet<AnyMember>
  /** Tags of `internal` commands that subscriptions deliver to; intents never reach them. */
  readonly handlerTags: ReadonlySet<string>
  readonly watches: ReadonlySet<string>
  readonly codecs: ReadonlyMap<string, MemberCodecs>
  readonly connectionCodecs: ReadonlyMap<string, ConnectionCodecs>
  readonly workflowExits: ReadonlyMap<string, ReturnType<typeof exitCodec>>
  readonly fields: Readonly<Record<string, ValueSchema>>
  readonly state: StateCodec
  readonly events: ReadonlyMap<string, EventClass>
  readonly eventCodecs: ReadonlyMap<string, ReturnType<typeof payloadCodec<EventClass>>>
  readonly feeds: ReadonlySet<string>
  readonly jobs: ReadonlyMap<string, CompiledJob>
  /** Tags of jobs whose executor progress some connection or stream receives. */
  readonly progressJobs: ReadonlySet<string>
  readonly policy: TurnPolicy
  readonly cron: ReadonlyArray<CronEntry>
  readonly tables: ReadonlyArray<AnyOwnedTable>
  readonly blobs: ReadonlyArray<AnyBlob>
  readonly subscriptions: ReadonlyArray<AnySubscription>
  readonly registeredSubscriptions: ReadonlyArray<RegisteredSubscription>
  /** Event and job chains this actor writes (or only reads, with `writes` false). */
  readonly payloads: (writes: boolean) => ReadonlyArray<PayloadDeclaration>
  /** What `durable payloads check` and `clear` read. */
  readonly definitionPayloads: DefinitionPayloads
  readonly served: ServedDefinition
  /** The handle that reaches `internal` commands too, for test harnesses. */
  readonly internal: InternalHandle
}

const descriptors = new WeakMap<WeakKey, Descriptor>()

/** The descriptor of an `Actor.make` definition, or undefined for any other value. */
export const descriptorOf = (definition: WeakKey): Descriptor | undefined =>
  descriptors.get(definition)

const tagMatches = (api: MemberRecord, internal: MemberRecord) => {
  const tags = new Set<string>()

  for (const [key, member] of [...Object.entries(api), ...Object.entries(internal)]) {
    if (key !== member.tag) throw new Error(`Command key ${key} must equal its tag ${member.tag}`)

    if (
      tags.has(member.tag) ||
      member.tag === "ref" ||
      member.tag === "state" ||
      member.tag.startsWith("$")
    )
      throw new Error(`Duplicate or reserved command: ${member.tag}`)
    tags.add(member.tag)
  }

  for (const member of Object.values(internal)) {
    if (member.kind !== "command")
      throw new Error(`Internal members must be commands: ${member.tag}`)
  }
}

const placementOf = (
  name: string,
  declared: Declaration,
  singleton: boolean,
  createdBy: string | undefined,
) => {
  const option = declared.placement ?? "tenant"

  if (option === "tenant" || option === "actor")
    return { placement: option as Placement, parent: undefined, depth: 0 }

  if (!Predicate.hasProperty(option, "parent"))
    throw new Error(`placement is "tenant", "actor", or { parent }`)

  const parent = descriptorOf(option.parent)

  if (parent === undefined) throw new Error("placement.parent takes an Actor.make definition")

  if (parent.placement === "tenant")
    throw new Error(
      `${name}'s parent ${parent.name} is tenant-placed, so its children already share its shard; place ${name} by "tenant"`,
    )

  if (parent.depth + 1 > MAX_PLACEMENT_DEPTH)
    throw new Error(
      `${name} would be ${parent.depth + 1} levels below its root; parent placement allows ${MAX_PLACEMENT_DEPTH}`,
    )

  if (singleton) throw new Error(`Singleton ${name} cannot be parent-placed`)

  if (declared.key === undefined && createdBy === undefined)
    throw new Error(`Parent-placed ${name} needs a key or createdBy`)

  const placement: Placement = { parent: parent.name, placement: parent.placement }

  return { placement, parent, depth: parent.depth + 1 }
}

const idSchemaOf = (
  name: string,
  key: Declaration["key"],
  parent: Descriptor | undefined,
): KeySchema => {
  const isLocalId = Schema.isSchema(key) ? Schema.is(key) : isMintedId

  if (parent !== undefined)
    return Schema.String.check(
      Schema.makeFilter(
        (id: string) => {
          const parts = parseChildId(id)

          return parts !== undefined && parent.isId(parts.parent) && isLocalId(parts.local)
        },
        { expected: `c1.<byte length>.<${parent.name} id>.<${name} local id>` },
      ),
    )

  if (Schema.isSchema(key)) return key

  if (key === undefined)
    return Schema.String.check(
      Schema.makeFilter((id: string) => isUUIDv7(id) || isMintedId(id), {
        expected: "a UUID v7 or a minted UUID v8",
      }),
    )

  return Schema.String.check(Schema.isUUID(7))
}

const compileJobs = (declared: Declaration, commands: ReadonlyArray<AnyCommand>) => {
  const jobs = new Map<string, CompiledJob>()

  for (const [key, binding] of Object.entries(declared.jobs ?? {})) {
    const job = binding?.job

    if (job === undefined || !Schema.isSchema(job) || job.tag === undefined)
      throw new Error(`jobs.${key} must bind an Actor.job value`)

    if (key !== job.tag) throw new Error(`jobs.${key} must be keyed by its job's tag ${job.tag}`)

    jobs.set(job.tag, {
      job,
      codec: payloadCodec({ schema: job, tag: job.tag }),
      policy: resolveJobPolicy({ path: `jobs.${key}`, declared: binding, commands }),
    })
  }

  return jobs
}

const compileSubscriptions = (
  name: string,
  singleton: boolean,
  internal: MemberRecord,
  subscriptions: ReadonlyArray<AnySubscription>,
  decodeId: Descriptor["decodeId"],
) => {
  const tags = new Set<string>()
  const handlerTags = new Set<string>()

  for (const declared of subscriptions) {
    if (declared?.kind !== "subscription")
      throw new Error("subscriptions takes Actor.subscription values")

    if (tags.has(declared.tag)) throw new Error(`Duplicate subscription: ${declared.tag}`)
    tags.add(declared.tag)

    if (internal[declared.handler.tag] !== declared.handler)
      throw new Error(`Subscription ${declared.tag}'s handler must be a command in internal`)
    handlerTags.add(declared.handler.tag)

    const source = descriptorOf(declared.source)

    if (source === undefined)
      throw new Error(`Subscription ${declared.tag}'s source must be an Actor.make definition`)

    if (source.policy.subscribers !== undefined && !source.policy.subscribers.includes(name))
      throw new Error(
        `${declared.source.name} policy.allowedSubscriberTypes does not allow ${name} (subscription ${declared.tag})`,
      )

    const toSingleton = declared.route !== undefined && !Predicate.isFunction(declared.route)

    if (singleton && declared.route !== undefined && !toSingleton)
      throw new Error(`Singleton ${name} routes subscription ${declared.tag} with Actor.singleton`)

    if (!singleton && toSingleton)
      throw new Error(
        `Subscription ${declared.tag} routes to Actor.singleton, but ${name} is keyed`,
      )
  }

  const registered = subscriptions.map((declared): RegisteredSubscription => {
    const decoders = new Map(
      declared.events.map(
        (event) =>
          [event.identifier, payloadCodec({ schema: event, tag: event.identifier })] as const,
      ),
    )

    const route = declared.route

    const codecOf = (tag: string) => {
      const codec = decoders.get(tag)

      return codec === undefined
        ? Effect.fail(
            SubscriptionFailure.make({ message: `Subscription ${declared.tag} names no ${tag}` }),
          )
        : Effect.succeed(codec)
    }

    return {
      tag: declared.tag,
      sourceType: declared.source.name,
      handler: declared.handler.tag,
      events: declared.events.map((event) => event.identifier),
      retired: declared.retired,
      routed: route === undefined ? undefined : Predicate.isFunction(route) ? "id" : "singleton",
      upcast: (tag, version, value) =>
        Effect.flatMap(codecOf(tag), (codec) => codec.upcast(value, version)).pipe(
          Effect.catchTag("PayloadError", (error) =>
            Effect.fail(SubscriptionFailure.make({ message: error.message })),
          ),
        ),
      route: (tag, value, source) =>
        Effect.gen(function* () {
          if (!Predicate.isFunction(route)) return "singleton"

          const codec = yield* codecOf(tag)
          const event = yield* codec.decode(value, codec.chain.current)

          const id = yield* Effect.try({
            try: () => route(event, source),
            catch: (cause) => SubscriptionFailure.make({ message: String(cause) }),
          })

          return yield* decodeId(id)
        }).pipe(
          Effect.catchTags({
            SchemaError: (error) =>
              Effect.fail(SubscriptionFailure.make({ message: error.message })),
            PayloadError: (error) =>
              Effect.fail(SubscriptionFailure.make({ message: error.message })),
          }),
        ),
    }
  })

  return { handlerTags, registered }
}

/**
 * Validates a declaration and compiles its descriptor, throwing on the first
 * invalid part. It publishes nothing: `publish` records the descriptor and
 * its table ownership only after the whole definition has compiled, so a
 * rejected definition leaves every registry as it was.
 */
export const compile = ({
  name,
  declared,
}: {
  readonly name: string
  readonly declared: Declaration
}): Descriptor => {
  NAME.make(name)
  const api = declared.api ?? {}
  const internal = declared.internal ?? {}
  tagMatches(api, internal)

  const members = [...Object.values(api), ...Object.values(internal)]
  const commands = members.filter((member): member is AnyCommand => member.kind === "command")
  const queries = members.filter((member) => member.kind === "query")

  const connections = members.filter(
    (member): member is AnyConnection => member.kind === "connection",
  )

  const streams = members.filter((member): member is AnyStream => member.kind === "stream")
  const reducers = members.filter((member): member is AnyReducer => member.kind === "reducer")
  const workflows = members.filter(isWorkflow)

  for (const member of Object.values(internal))
    if (isWorkflow(member)) throw new Error(`Workflow ${member.tag} must be in api`)

  const fields = declared.state?.fields ?? {}

  const policy = resolvePolicy({
    declared: declared.policy,
    createdBy: declared.createdBy,
    commands,
  })

  const cron = resolveSchedules({ declared: declared.schedules, commands })
  const singleton = isSingletonKey(declared.key)
  const jobs = compileJobs(declared, commands)
  const progressJobs = new Set<string>()

  for (const member of [...connections, ...streams])
    for (const job of member.progress?.jobs ?? []) {
      if (jobs.get(job.tag)?.job !== job || job.progress === undefined)
        throw new Error(
          `${member.tag} lists progress of ${job.tag}, which is not a bound job with a progress schema`,
        )
      progressJobs.add(job.tag)
    }

  if ("set" in fields) throw new Error("State key 'set' is reserved")

  for (const reducer of reducers)
    if (reducer.state !== declared.state)
      throw new Error(`Reducer ${reducer.tag} must declare its actor's state`)

  const tables = declared.tables ?? []
  const { placement, parent, depth } = placementOf(name, declared, singleton, policy.createdBy)

  for (const table of tables) {
    const info = ownership(table)

    if (info === undefined) throw new Error("tables takes Actor.table values")

    if (tables.indexOf(table) !== tables.lastIndexOf(table))
      throw new Error(`Table ${info.name} is listed twice`)

    if (info.owner !== undefined && info.owner !== name)
      throw new Error(`Table ${info.name} is already owned by actor ${info.owner}`)

    if (info.adopted && policy.createdBy !== undefined)
      throw new Error(
        `Actor ${name} mints its ids and cannot adopt table ${info.name}: legacy rows carry ids it never minted`,
      )
  }

  const events = new Map<string, EventClass>()

  for (const event of declared.events ?? []) {
    if (events.has(event.identifier)) throw new Error(`Duplicate event: ${event.identifier}`)
    events.set(event.identifier, event)
  }

  const feeds = new Set<string>()

  for (const event of declared.feeds ?? []) {
    if (events.get(event.identifier) !== event)
      throw new Error(`Feed ${event.identifier} is not one of ${name}'s events`)
    feeds.add(event.identifier)
  }

  const eventCodecs = new Map(
    [...events.values()].map(
      (event) =>
        [event.identifier, payloadCodec({ schema: event, tag: event.identifier })] as const,
    ),
  )

  const blobs = declared.blobs ?? []
  const blobNames = new Set<string>()

  for (const blob of blobs) {
    if (!isBlob(blob)) throw new Error("blobs takes Actor.blob and Actor.content values")

    if (blobNames.has(blob.name)) throw new Error(`Blob ${blob.name} is listed twice`)
    blobNames.add(blob.name)
  }

  const migrations = declared.state?.migrations ?? []
  ActorStates.validateChain(fields, migrations)

  const idSchema = idSchemaOf(name, declared.key, parent)
  const decodeIdSchema = Schema.decodeEffect(idSchema)
  const encodeIdSchema = Schema.encodeEffect(idSchema)

  const decodeId: Descriptor["decodeId"] = singleton
    ? () => Effect.succeed("singleton")
    : (id) => decodeIdSchema(id)

  const encodeId: Descriptor["encodeId"] = singleton
    ? () => Effect.succeed("singleton")
    : (id) => encodeIdSchema(id)

  const subscriptions = declared.subscriptions ?? []

  const { handlerTags, registered } = compileSubscriptions(
    name,
    singleton,
    internal,
    subscriptions,
    (id) => decodeIdSchema(id),
  )

  for (const member of Object.values(api)) checkDeclaredErrors(member)

  const codecs = new Map(members.map((member) => [member.tag, memberCodecs(member)] as const))

  const connectionCodecs = new Map(
    connections.map((member) => {
      const server = valueCodec(member.server)
      const client = valueCodec(member.client)
      const session = member.session === undefined ? undefined : valueCodec(member.session)

      return [
        member.tag,
        {
          encodeServer: Schema.encodeEffect(server),
          decodeClient: Schema.decodeEffect(client),
          encodeSession: session === undefined ? undefined : Schema.encodeEffect(session),
          decodeSession: session === undefined ? undefined : Schema.decodeEffect(session),
        },
      ] as const
    }),
  )

  const payloads = (writes: boolean): ReadonlyArray<PayloadDeclaration> => [
    ...[...events.values()].map((event) => ({
      actorType: name,
      kind: "event" as const,
      tag: event.identifier,
      chain: payloadChain(event),
      writes,
    })),
    ...[...jobs.values()].map(({ job }) => ({
      actorType: name,
      kind: "job" as const,
      tag: job.tag,
      chain: payloadChain(job),
      writes,
    })),
  ]

  const mintable = declared.key === undefined && policy.createdBy !== undefined
  const minted = !singleton && declared.key === undefined && parent === undefined

  const served: ServedDefinition = {
    name,
    key: singleton ? "singleton" : minted ? "minted" : "keyed",
    decodeId,
    encodeId,
    members: Object.values(api)
      .filter(
        (member) =>
          member.kind !== "connection" && member.kind !== "stream" && member.kind !== "workflow",
      )
      .map((member) => servedMember({ member, codecs: codecs.get(member.tag)! })),
    connections: connections.map(servedConnection),
    feeds: [...feeds],
    contents: blobs.flatMap((blob) => (isContent(blob) ? [blob.name] : [])),
    streams: streams.map((member) => servedMember({ member, codecs: codecs.get(member.tag)! })),
  }

  const descriptor: Descriptor = Object.freeze({
    name,
    access: declared.access,
    singleton,
    mintable,
    minted,
    placement,
    depth,
    parent,
    idSchema,
    decodeId,
    encodeId,
    isId: singleton ? (id: string) => id === "singleton" : Schema.is(idSchema),
    childId: (parentId: string, local: string) => {
      if (parent === undefined) throw new Error(`${name} is not parent-placed`)

      return childId({ parent: parentId, local })
    },
    api,
    internalCommands: internal,
    members,
    commands,
    queries,
    reducers,
    connections,
    streams,
    workflows,
    internalMembers: new Set(Object.values(internal)),
    handlerTags,
    watches: new Set(
      queries.flatMap((member) => ("watch" in member && member.watch === true ? [member.tag] : [])),
    ),
    codecs,
    connectionCodecs,
    workflowExits: new Map(
      workflows.map((member) => [
        member.tag,
        exitCodec({ success: member.success, error: member.error }),
      ]),
    ),
    fields,
    state: stateCodec({ fields, migrations, maxBytes: policy.stateMaxBytes }),
    events,
    eventCodecs,
    feeds,
    jobs,
    progressJobs,
    policy,
    cron,
    tables,
    blobs,
    subscriptions,
    registeredSubscriptions: registered,
    payloads,
    definitionPayloads: {
      declarations: payloads(true),
      keepEventsMs: policy.keepEventsMs,
      commandTimeoutMs: policy.executionMs,
    },
    served,
    internal: {
      handle: (id: string, tenant: string, caller: typeof System.Type) =>
        handleOf(descriptor, id, true, caller, tenant),
    },
  })

  return descriptor
}

/**
 * Records `descriptor` for `definition` and gives its tables to the actor
 * type. `compile` has already validated every table, so this cannot fail
 * part-way.
 */
export const publish = ({
  definition,
  descriptor,
}: {
  readonly definition: WeakKey
  readonly descriptor: Descriptor
}) => {
  for (const table of descriptor.tables) {
    const info = ownership(table)!
    info.owner = descriptor.name
    info.placement = descriptor.placement
  }

  descriptors.set(definition, descriptor)
}
