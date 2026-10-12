import {
  Clock,
  DateTime,
  Duration,
  Effect,
  JsonPatch,
  Predicate,
  PubSub,
  Result,
  Schema,
  Stream,
} from "effect"
import type { Caller } from "../contract/caller.ts"
import type { Bounds } from "../contract/context.ts"
import { ActionDefect, ActorError, InvalidInput, Unauthorized } from "../contract/errors.ts"
import type { Reply, StateFrame, Target, Transport } from "../contract/handle.ts"
import type { AccessRequest, AnyActor } from "../contract/make.ts"
import type { Action, View } from "../contract/members.ts"
import { Lists } from "../handlers/lists.ts"
import { CommandIds } from "./command-ids.ts"
import { Durable } from "./durable.ts"
import type { ActorRecord } from "./durable.ts"
import type { Engine } from "./engine.ts"
import { Origin, Outcome } from "./entries.ts"
import { Layouts } from "./layout.ts"
import type { Decoded } from "./layout.ts"

const denied = (): ActorError =>
  ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) })

const unknownMember = (member: string): ActorError =>
  ActorError.make({
    reason: InvalidInput.make({
      code: "unknown_member",
      issues: [{ path: member, message: "not a public member" }],
    }),
  })

const invalid = (member: string, message: string): ActorError =>
  ActorError.make({
    reason: InvalidInput.make({ code: "decode", issues: [{ path: member, message }] }),
  })

/** Runs the actor's `access` guard; a guard that throws refuses. */
const allowed = (
  actor: AnyActor,
  caller: Caller,
  request: AccessRequest,
): Effect.Effect<void, ActorError> =>
  Effect.suspend(() => {
    try {
      return actor.access(caller, request) ? Effect.void : Effect.fail(denied())
    } catch {
      return Effect.fail(denied())
    }
  })

/** Turns a recorded outcome into the reply a caller receives; a defect reaches it as `ActionDefect`. */
const reply = (actor: AnyActor, member: string, outcome: Outcome): Effect.Effect<Reply> =>
  Outcome.match(outcome, {
    Success: ({ value }) => Effect.succeed<Reply>({ kind: "Success", value }),
    Failure: ({ error }) => Effect.succeed<Reply>({ kind: "Failure", error }),
    Defect: ({ kind, detail }) =>
      Effect.die(ActionDefect.make({ kind, actor: actor.name, member, detail })),
  })

const decodes = (schema: Action["payload"], value: Schema.Json): string | undefined => {
  if (schema === undefined) return undefined
  const result = Schema.decodeResult(MemberJson(schema))(value)
  return Result.isFailure(result) ? result.failure.message : undefined
}

const MemberJson = (schema: NonNullable<Action["payload"]>) => Schema.toCodecJson(schema)

/**
 * Admits a client's call under its client id, in the contract's order: `access`, the member, the
 * payload, the id, then (on the owner) expiry and the duplicate lookup before anything runs.
 */
const admit = (
  engine: Engine,
  caller: Caller,
  commandId: string,
  request: {
    readonly actor: AnyActor
    readonly id: Schema.Json
    readonly member: string
    readonly payload: Schema.Json
  },
) =>
  Effect.gen(function* () {
    const { actor, member } = request
    yield* allowed(actor, caller, { kind: "action", member })
    const declaration: Action | undefined = actor.actions[member]
    if (declaration === undefined || declaration.internal || !engine.catalog.actors.has(actor.name))
      return yield* unknownMember(member)
    const problem = decodes(declaration.payload, request.payload)
    if (problem !== undefined) return yield* invalid(member, problem)
    const now = yield* Clock.currentTimeMillis
    const parsed = CommandIds.parse(commandId, now)
    if (Result.isFailure(parsed)) return yield* ActorError.make({ reason: parsed.failure })
    const outcome = yield* engine.execute({
      origin: Origin.cases.External.make({ expiresAt: parsed.success.expiresAt }),
      commandId,
      actor,
      keyJson: request.id,
      member,
      payload: request.payload,
      caller,
      connection: undefined,
    })
    return yield* reply(actor, member, outcome)
  })

/** The state fields a client sees: every encoded field except lists, which are never in it. */
const clientState = (record: ActorRecord): Schema.Json => ({ ...record.image.encoded })

const readState = (record: ActorRecord): Decoded => {
  const layout = Layouts.of(record.actor)
  const state = { ...record.image.state }
  for (const [name, list] of layout.lists)
    state[name] = Lists.reader(record.image.lists.get(name) ?? Lists.empty, list.ordering)
  return state
}

/** A stream of the durable record, read now and again after each durable change. */
const changes = (
  engine: Engine,
  actor: AnyActor,
  id: Schema.Json,
): Stream.Stream<{ readonly version: number; readonly record: ActorRecord }, ActorError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const channel = yield* engine.channel(Durable.addressOf(actor.name, id))
      const subscription = yield* PubSub.subscribe(channel.changes)
      const first = yield* engine.durableRecord(actor, id)
      return Stream.concat(
        Stream.make({ version: channel.version, record: first }),
        Stream.fromSubscription(subscription).pipe(
          Stream.mapEffect((version) =>
            Effect.map(engine.durableRecord(actor, id), (record) => ({ version, record })),
          ),
        ),
      )
    }),
  )

const scalar = (value: Decoded): Decoded =>
  DateTime.isDateTime(value) ? DateTime.toEpochMillis(value) : value

const matches = (state: Decoded, where: Readonly<Record<string, Decoded>>): boolean => {
  for (const [field, condition] of Object.entries(where)) {
    const value = scalar(state[field])
    if (Predicate.isObject(condition) && !DateTime.isDateTime(condition)) {
      const bounds: Bounds<Decoded> = condition
      if (bounds.gt !== undefined && !(value > scalar(bounds.gt))) return false
      if (bounds.gte !== undefined && !(value >= scalar(bounds.gte))) return false
      if (bounds.lt !== undefined && !(value < scalar(bounds.lt))) return false
      if (bounds.lte !== undefined && !(value <= scalar(bounds.lte))) return false
      if (bounds.in !== undefined && !bounds.in.map(scalar).includes(value)) return false
    } else if (value !== scalar(condition)) return false
  }
  return true
}

/**
 * The read side every transport shares: `state` and lists from durable state only, views
 * recomputed on durable change, events after durability, presence through `connect` and
 * `disconnect`, and `find` over every shard.
 */
const reads = (engine: Engine, caller: Caller): Omit<Transport, "call"> => ({
  state: (target: Target) =>
    Stream.unwrap(
      Effect.as(
        allowed(target.actor, caller, { kind: "state", member: "state" }),
        changes(engine, target.actor, target.id),
      ),
    ).pipe(
      Stream.mapAccum(
        (): Schema.Json | undefined => undefined,
        (
          last,
          { version, record },
        ): readonly [Schema.Json | undefined, ReadonlyArray<StateFrame>] => {
          const value = clientState(record)
          if (last === undefined) return [value, [{ kind: "Frame", version, value }]]
          const ops = JsonPatch.get(last, value)
          return [value, ops.length === 0 ? [] : [{ kind: "Patch", version, ops }]]
        },
      ),
    ),
  view: (request) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { actor, member } = request
        yield* allowed(actor, caller, { kind: "view", member })
        const declaration: View | undefined = actor.views[member]
        const handler = engine.catalog.actors.get(actor.name)?.registered.handlers.get(member)
        if (declaration === undefined || handler === undefined) return yield* unknownMember(member)
        const problem = decodes(declaration.params, request.params)
        if (problem !== undefined) return yield* invalid(member, problem)
        const params = Layouts.codec(declaration.params).decode(request.params)
        const success = Layouts.codec(declaration.success)
        return changes(engine, actor, request.id).pipe(
          Stream.mapEffect(({ record }) =>
            Effect.suspend(() => {
              try {
                return Effect.succeed(
                  success.encode(handler(readState(record), params, { caller, self: record.key })),
                )
              } catch (thrown) {
                return Effect.die(
                  ActionDefect.make({
                    kind: "Thrown",
                    actor: actor.name,
                    member,
                    detail: String(thrown),
                  }),
                )
              }
            }),
          ),
          Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)),
        )
      }),
    ),
  event: (request) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* allowed(request.actor, caller, { kind: "event", member: request.member })
        const channel = yield* engine.channel(Durable.addressOf(request.actor.name, request.id))
        const subscription = yield* PubSub.subscribe(channel.events)
        return Stream.fromSubscription(subscription).pipe(
          Stream.filterMap((emitted) =>
            emitted.event === request.member ? Result.succeed(emitted.value) : Result.failVoid,
          ),
        )
      }),
    ),
  range: (request) =>
    Effect.gen(function* () {
      yield* allowed(request.actor, caller, { kind: "list", member: request.member })
      const list = Layouts.of(request.actor).lists.get(request.member)
      if (list === undefined) return yield* unknownMember(request.member)
      const record = yield* engine.durableRecord(request.actor, request.id)
      return Lists.window(
        record.image.lists.get(request.member) ?? Lists.empty,
        list.ordering,
        request.range,
      ).map(list.item.encode)
    }),
  watch: (request) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* allowed(request.actor, caller, { kind: "list", member: request.member })
        const list = Layouts.of(request.actor).lists.get(request.member)
        if (list === undefined) return yield* unknownMember(request.member)
        return changes(engine, request.actor, request.id).pipe(
          Stream.map(({ record }) =>
            Lists.window(
              record.image.lists.get(request.member) ?? Lists.empty,
              list.ordering,
              request.range,
            ).map(list.item.encode),
          ),
          Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)),
        )
      }),
    ),
  join: (request) =>
    Effect.gen(function* () {
      const { actor } = request
      yield* allowed(actor, caller, { kind: "join", member: "join" })
      if (actor.presence === undefined) return yield* unknownMember("join")
      const problem = decodes(actor.presence, request.presence)
      if (problem !== undefined) return yield* invalid("join", problem)
      const now = yield* Clock.currentTimeMillis
      const connection = yield* CommandIds.mint(now)
      const presence = (member: "connect" | "disconnect", commandId: string, origin: Origin) =>
        engine
          .execute({
            origin,
            commandId,
            actor,
            keyJson: request.id,
            member,
            payload: request.presence,
            caller,
            connection,
          })
          .pipe(
            retryWhileUnavailable,
            Effect.flatMap((outcome) => reply(actor, member, outcome)),
          )
      const parsed = CommandIds.parse(connection, now)
      if (Result.isFailure(parsed)) return yield* ActorError.make({ reason: parsed.failure })
      yield* Effect.acquireRelease(
        presence(
          "connect",
          connection,
          Origin.cases.External.make({ expiresAt: parsed.success.expiresAt }),
        ),
        () =>
          presence(
            "disconnect",
            CommandIds.derive(connection, "disconnect"),
            Origin.cases.Local.make({}),
          ).pipe(Effect.ignore),
      )
    }),
  find: (request) =>
    Effect.gen(function* () {
      const { actor, query } = request
      yield* allowed(actor, caller, { kind: "find", member: "find" })
      const records = yield* engine.instances(actor)
      const where = query.where ?? {}
      const selected = records.filter((record) => matches(record.image.state, where))
      const order = query.orderBy
      if (order !== undefined) {
        const direction = order.direction === "desc" ? -1 : 1
        selected.sort((left, right) => {
          const a = scalar(left.image.state[order.field])
          const b = scalar(right.image.state[order.field])
          if (a === b) return 0
          if (a === undefined) return 1
          if (b === undefined) return -1
          return (a < b ? -1 : 1) * direction
        })
      }
      return selected
        .slice(0, Math.min(query.limit ?? 1_000, 1_000))
        .map((record) => record.keyJson)
    }),
})

const retryWhileUnavailable = <A>(
  effect: Effect.Effect<A, ActorError>,
): Effect.Effect<A, ActorError> =>
  effect.pipe(
    Effect.catchIf(
      (error) => error.isRetryable,
      (error) =>
        Effect.flatMap(Effect.sleep(Duration.millis(error.retryAfter ?? 100)), () =>
          Effect.fail(error),
        ),
    ),
    Effect.retry({ while: (error) => error.isRetryable, times: 200 }),
  )

/**
 * An in-process client: mints one client id per call, sends it, and retries with the same id
 * while the owner is unavailable, as the `/rpc` client does across an owner change.
 */
const client = (engine: Engine, caller: Caller): Transport => {
  const call: Transport["call"] = (request) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const commandId = yield* CommandIds.mint(now)
      return yield* retryWhileUnavailable(admit(engine, caller, commandId, request))
    })
  return { call, ...reads(engine, caller) }
}

/** Every transport that reaches the in-process engine. */
export const Transports = { admit, client, reads, reply, retryWhileUnavailable }
