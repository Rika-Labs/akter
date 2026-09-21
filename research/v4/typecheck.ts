// Type assertions for the proposed surface. `Eq` is strict: `any` is not equal to anything else.
// Run: bunx tsc --noEmit -p research/v4/tsconfig.json
import type { Duration, Effect, Layer, Option, Scope, Stream } from "effect"
import { Effect as E, Schema } from "effect"
import type { ActorEvent, ActorUnavailable, CommandConflict, CurrentCaller, EventsOf, HandleOf, IntentOptions, NotCreated } from "./framework/Actor.ts"
import { Actor, Actors, Cron, Database, Hibernate, Lifecycle } from "./framework/Actor.ts"
import { Chat, InvalidMessage, Message, MessageAdded, NotAMember, RoomId, SendEmail } from "./example/Chat.ts"
import { ChatReads } from "./example/Chat.queries.ts"
import { ChatLive, RoomAccess } from "./example/Chat.server.ts"
import { CountChanged, Counter, CounterId, GetCount, Increment, Overflow, Reset } from "./example/Counter.ts"
import { CounterLive } from "./example/Counter.server.ts"
import { NightlyLive } from "./example/Nightly.server.ts"
import { Onboard } from "./example/Onboard.ts"
import { OnboardLive } from "./example/Onboard.server.ts"
import { AgentSessionLive } from "./example/AgentSession.server.ts"
import { AppLive, program, ticks } from "./example/usage.ts"

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
export const _sanity: Eq<any, string> = false

type CounterHandle = Effect.Success<ReturnType<typeof Counter.get>>
type ChatHandle = Effect.Success<ReturnType<typeof Chat.get>>
// the handler context types, as the server file sees them
type CounterCtx = Parameters<Parameters<typeof Counter.toLayer<never>>[0]["Increment"]>[0]
type ChatCtx = Parameters<Parameters<typeof Chat.of<never>>[0]["SendMessage"]>[0]
type ChatQueryCtx = Parameters<Parameters<typeof Chat.ofQueries<never>>[0]["Recent"]>[0]

export const _handleOf: Eq<HandleOf<typeof Counter>, CounterHandle> = true
export const _eventsOf: Eq<EventsOf<typeof Counter>, typeof CountChanged> = true
export const _get: Eq<ReturnType<typeof Counter.get>, Effect.Effect<CounterHandle, never, Actors>> = true
export const _getArgs: Eq<Parameters<typeof Counter.get>[0], CounterId> = true
// every call from outside a turn names its caller: R = CurrentCaller
export const _inc: Eq<ReturnType<CounterHandle["Increment"]>, Effect.Effect<number, Overflow | CommandConflict | ActorUnavailable, CurrentCaller>> = true
export const _incArgs: Eq<Parameters<CounterHandle["Increment"]>, [input: number]> = true
export const _reset: Eq<ReturnType<CounterHandle["Reset"]>, Effect.Effect<void, CommandConflict | ActorUnavailable, CurrentCaller>> = true
export const _resetArgs: Eq<Parameters<CounterHandle["Reset"]>, []> = true
// queries run on the caller's node: no Cluster hop, so no ActorUnavailable
export const _getCount: Eq<ReturnType<CounterHandle["GetCount"]>, Effect.Effect<number, never, CurrentCaller>> = true
export const _recent: Eq<ReturnType<ChatHandle["Recent"]>, Effect.Effect<ReadonlyArray<Message>, NotAMember, CurrentCaller>> = true
export const _transcript: Eq<ReturnType<ChatHandle["Transcript"]>, Stream.Stream<Message, NotAMember | ActorUnavailable, CurrentCaller>> = true
export const _events: Eq<Effect.Success<typeof ticks>, Stream.Stream<ActorEvent<CountChanged>, never, Scope.Scope>> = true
export const _sendArgs: Eq<Parameters<ChatHandle["SendMessage"]>[0], { readonly id: string; readonly body: string }> = true
export const _sendOut: Eq<Effect.Success<ReturnType<ChatHandle["SendMessage"]>>, Message> = true

// intents exist only inside a turn, on `ctx.self` / `ctx.actors`
export const _selfAfter: Eq<CounterCtx["self"]["Reset"]["after"], (delay: Duration.Input, options?: IntentOptions) => Effect.Effect<void>> = true
export const _selfSend: Eq<CounterCtx["self"]["Increment"]["send"], (input: number, options?: IntentOptions) => Effect.Effect<void>> = true
// a turn can tombstone its own actor
export const _terminate: Eq<CounterCtx["terminate"], Effect.Effect<void>> = true

// explicit creation: every command except the creating one carries NotCreated
const Created = Actor.make("Created", {
  id: CounterId,
  commands: [Increment, Reset],
  queries: [GetCount],
  events: [CountChanged],
  lifecycle: [Hibernate.after("1 minute"), Lifecycle.createdBy(Increment)]
})
type CreatedHandle = Effect.Success<ReturnType<typeof Created.get>>
export const _createdIncrement: Eq<ReturnType<CreatedHandle["Increment"]>, Effect.Effect<number, Overflow | CommandConflict | ActorUnavailable, CurrentCaller>> = true
export const _createdReset: Eq<ReturnType<CreatedHandle["Reset"]>, Effect.Effect<void, CommandConflict | ActorUnavailable | NotCreated, CurrentCaller>> = true

// inside a workflow: System caller, no delivery errors
type WfCtx = Parameters<Parameters<typeof Onboard.toLayer>[0]>[0]
declare const wfCtx: WfCtx
const wfRoom = wfCtx.actors.get(Chat, RoomId.make("room-1"))
const waitForMessage = () => wfCtx.waitFor(Chat, RoomId.make("room-1"), MessageAdded)
export const _wfSend: Eq<ReturnType<(typeof wfRoom)["SendMessage"]>, Effect.Effect<Message, InvalidMessage | NotAMember>> = true
export const _wfTranscript: Eq<ReturnType<(typeof wfRoom)["Transcript"]>, Stream.Stream<Message, NotAMember>> = true
export const _wfWait: Eq<ReturnType<typeof waitForMessage>, Effect.Effect<Option.Option<MessageAdded>>> = true

export const _programR: Eq<Effect.Services<typeof program>, Actors> = true
export const _counterLayer: Eq<typeof CounterLive, Layer.Layer<never, never, Actors>> = true
export const _chatLayer: Eq<typeof ChatLive, Layer.Layer<never, never, RoomAccess | Actors>> = true
// queries never touch the entity: Database, plus whatever the handlers need
export const _chatReads: Eq<typeof ChatReads, Layer.Layer<never, never, RoomAccess | Database>> = true
export const _onboardLayer: Eq<typeof OnboardLive, Layer.Layer<never, never, Actors>> = true
export const _nightlyLayer: Eq<typeof NightlyLive, Layer.Layer<never, never, Actors>> = true
export const _agentLayer: Eq<typeof AgentSessionLive, Layer.Layer<never, never, Actors>> = true
export const _appR: Eq<Layer.Services<typeof AppLive>, never> = true

// negatives: each line must fail to compile
export const _badId = E.gen(function*() {
  // @ts-expect-error CounterId is branded
  yield* Counter.get("plain-string")
})
export const _badCalls = E.gen(function*() {
  const counter = yield* Counter.get(CounterId.make("c1"))
  // @ts-expect-error Increment takes a number
  yield* counter.Increment("1")
  // @ts-expect-error unknown command
  yield* counter.Decrement(1)
  // @ts-expect-error fire-and-forget is not available outside a turn
  yield* counter.Increment.after("1 hour", 1)
  // @ts-expect-error fire-and-forget is not available outside a turn
  yield* counter.Reset.send()
})
// a call whose caller was never provided still requires CurrentCaller: it cannot be run as-is
export const _missingCaller = E.flatMap(Counter.get(CounterId.make("c1")), (counter) => counter.Increment(1))
export const _missingCallerR: Eq<Effect.Services<typeof _missingCaller>, Actors | CurrentCaller> = true
export const _badIntent = (ctx: CounterCtx) =>
  // @ts-expect-error intents are not callable: send / after / at only
  ctx.self.Reset()
// @ts-expect-error cron cannot supply a payload, so it needs a zero-input command
export const _badCron = Cron.every("* * * * *", Increment)
export const _badPerform = (ctx: ChatCtx) =>
  // @ts-expect-error MessageAdded is an event, not a declared effect
  ctx.perform(new MessageAdded({ message: {} as Message }))
export const _badEmit = (ctx: ChatCtx) =>
  // @ts-expect-error SendEmail is an effect, not a declared event
  ctx.emit(new SendEmail({ to: "a@b.c", body: "hi" }))
export const _badQueryEmit = (ctx: ChatQueryCtx) =>
  // @ts-expect-error query contexts cannot emit
  ctx.emit(new MessageAdded({ message: {} as Message }))
export const _badMemory = (ctx: CounterCtx) =>
  // @ts-expect-error per-activation state is a closure in the server file, not a framework slot
  ctx.memory
export const _badHandlers = Counter.toLayer({
  // @ts-expect-error InvalidMessage is not declared on Increment
  Increment: (_ctx, _n) => E.fail(new InvalidMessage({ reason: "empty" })),
  Reset: () => E.void
})
// @ts-expect-error handlers are missing
export const _missingHandlers = Counter.toLayer({})
// @ts-expect-error queries do not belong in the entity layer
export const _queryInToLayer = Chat.toLayer({ Recent: () => E.succeed([] as Array<Message>) })
// @ts-expect-error commands do not belong in the query layer
export const _commandInQueries = Chat.queries({ SendMessage: (_ctx, _input) => E.succeed({} as Message) })
export const _badWaitFor = () =>
  // @ts-expect-error CountChanged is not one of Chat's events
  wfCtx.waitFor(Chat, RoomId.make("room-1"), CountChanged)
export const _badActorsGet = E.gen(function*() {
  const actors = yield* Actors
  // @ts-expect-error CounterId is not a RoomId
  actors.get(Chat, CounterId.make("x"))
  // the branded form is the only one that compiles
  actors.get(Chat, RoomId.make("room-1"))
})
// @ts-expect-error a Principal is not a bare string
export const _badPrincipal = Actor.as("u1")
export const _schemaSanity: Eq<typeof Schema.String.Type, string> = true
