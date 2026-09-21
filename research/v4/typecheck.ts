// Type assertions for the proposed surface. `Eq` is strict: `any` is not equal to anything else.
// Run: bunx tsc --noEmit -p research/v4/tsconfig.json
import type { Duration, Effect, Exit, Layer, Option, Scope, Stream } from "effect"
import { Cause, Effect as E, Schema } from "effect"
import type { Arbitrary } from "effect/unstable/arbitrary"
import { Context } from "effect"
import type {
  ActorError,
  ActorEvent,
  ActorUnavailable,
  CommandConflict,
  EffectContext,
  EffectExecutors,
  EventsOf,
  HandleOf,
  IntentOptions,
  MailboxFull,
  NotCreated,
  Timeout,
  WorkflowRun
} from "./framework/Actor.ts"
import { Actor, Actors, Caller, Cron, Database, Hibernate, Lifecycle } from "./framework/Actor.ts"
import { Chat, InvalidMessage, MarkDelivered, Message, MessageAdded, NotAMember, RoomId, SendEmail } from "./example/Chat.ts"
import { ChatReads } from "./example/Chat.queries.ts"
import { ChatLive, RoomAccess } from "./example/Chat.server.ts"
import { CountChanged, Counter, CounterId, GetCount, Increment, Overflow, Reset } from "./example/Counter.ts"
import { AgentSession, RunTool, ToolFinished } from "./example/AgentSession.ts"
import { CodingAgent } from "./example/CodingAgent.ts"
import { CounterLive } from "./example/Counter.server.ts"
import type { Mailer } from "./example/Mailer.ts"
import { NightlyLive } from "./example/Nightly.server.ts"
import { FirstMessage, User } from "./example/User.ts"
import { UserLive } from "./example/User.server.ts"
import { AgentSessionLive, Model, Tools } from "./example/AgentSession.server.ts"
import { AppLive } from "./example/server.ts"
import { program, ticks } from "./example/usage.ts"
import type { ActorState, Model as TestModel, Script, Step, TurnRecord } from "./framework/Testing.ts"
import { ActorTest, Scripts } from "./framework/Testing.ts"

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
export const _sanity: Eq<any, string> = false

/** What a Cluster hop can do to a call; the reasons every command shares. */
type Delivery = ActorUnavailable | MailboxFull | Timeout

type CounterHandle = Effect.Success<ReturnType<typeof Counter.get>>
type ChatHandle = Effect.Success<ReturnType<typeof Chat.get>>
type UserHandle = Effect.Success<ReturnType<typeof User.get>>
// the handler context types, as the server file sees them
type CounterCtx = Parameters<Parameters<typeof Counter.toLayer<never>>[0]["Increment"]>[0]
type ChatCtx = Parameters<Parameters<typeof Chat.of<never>>[0]["SendMessage"]>[0]
type ChatQueryCtx = Parameters<Parameters<typeof Chat.ofQueries<never>>[0]["Recent"]>[0]

export const _handleOf: Eq<HandleOf<typeof Counter>, CounterHandle> = true
export const _eventsOf: Eq<EventsOf<typeof Counter>, typeof CountChanged> = true
// resolving a handle needs the runtime; the caller is ambient (`CurrentCaller` is a Reference with a default)
export const _get: Eq<ReturnType<typeof Counter.get>, Effect.Effect<CounterHandle, never, Actors>> = true
export const _getArgs: Eq<Parameters<typeof Counter.get>[0], CounterId> = true
// the caller is bound at `get`, so every method on the handle has R = never (decision 89)
export const _inc: Eq<ReturnType<CounterHandle["Increment"]>, Effect.Effect<number, Overflow | ActorError.Of<Delivery | CommandConflict>, never>> = true
export const _incArgs: Eq<Parameters<CounterHandle["Increment"]>, [input: number]> = true
export const _reset: Eq<ReturnType<CounterHandle["Reset"]>, Effect.Effect<void, ActorError.Of<Delivery | CommandConflict>, never>> = true
export const _resetArgs: Eq<Parameters<CounterHandle["Reset"]>, []> = true
// queries run on the caller's node: no Cluster hop, so no ActorError at all
export const _getCount: Eq<ReturnType<CounterHandle["GetCount"]>, Effect.Effect<number, never, never>> = true
export const _recent: Eq<ReturnType<ChatHandle["Recent"]>, Effect.Effect<ReadonlyArray<Message>, NotAMember, never>> = true
// streams own their scope in rc.116 (decision 99): R = never here too
export const _transcript: Eq<ReturnType<ChatHandle["Transcript"]>, Stream.Stream<Message, NotAMember | ActorError.Of<Delivery>, never>> = true
export const _events: Eq<Effect.Success<typeof ticks>, Stream.Stream<ActorEvent<CountChanged>, never, never>> = true
// the framework mints the commandId; the message id is `ctx.commandId`, not a field of the input
export const _sendArgs: Eq<Parameters<ChatHandle["SendMessage"]>[0], { readonly body: string }> = true
export const _sendOut: Eq<Effect.Success<ReturnType<ChatHandle["SendMessage"]>>, Message> = true
// a connection is scoped: closing the scope closes the socket
export const _live: Eq<
  ReturnType<ChatHandle["Live"]>,
  Effect.Effect<Effect.Success<ReturnType<ChatHandle["Live"]>>, NotAMember | ActorError.Of<Delivery>, Scope.Scope>
> = true

// workflows are members of their owner (decision 158)
export const _workflowStart: Eq<
  ReturnType<UserHandle["Onboard"]["start"]>,
  Effect.Effect<WorkflowRun<{ readonly nudged: boolean }, NotAMember>, ActorError.Of<Delivery>, never>
> = true
export const _workflowStartArgs: Eq<Parameters<UserHandle["Onboard"]["start"]>, [input: { readonly roomId: RoomId }, options?: { readonly key?: string }]> = true

// intents exist only inside a turn, on `ctx.self` / `ctx.actors`
export const _selfAfter: Eq<CounterCtx["self"]["Reset"]["after"], (delay: Duration.Input, options?: IntentOptions) => Effect.Effect<void>> = true
export const _selfSend: Eq<CounterCtx["self"]["Increment"]["send"], (input: number, options?: IntentOptions) => Effect.Effect<void>> = true
// a turn can tombstone its own actor
export const _terminate: Eq<CounterCtx["terminate"], Effect.Effect<void>> = true
// the ref is the user-facing address: serializable, printable, on the handle and on every turn record
export const _handleRef: Eq<CounterHandle["ref"], CounterCtx["ref"]> = true

// explicit creation: every command except the creating one carries NotCreated
const Created = Actor.make("Created", {
  id: CounterId,
  commands: [Increment, Reset],
  queries: [GetCount],
  events: [CountChanged],
  lifecycle: [Hibernate.after("1 minute"), Lifecycle.createdBy(Increment)]
})
type CreatedHandle = Effect.Success<ReturnType<typeof Created.get>>
export const _createdIncrement: Eq<ReturnType<CreatedHandle["Increment"]>, Effect.Effect<number, Overflow | ActorError.Of<Delivery | CommandConflict>, never>> = true
export const _createdReset: Eq<ReturnType<CreatedHandle["Reset"]>, Effect.Effect<void, ActorError.Of<Delivery | CommandConflict | NotCreated>, never>> = true

// inside a workflow body: System caller, full request/reply, no delivery errors
type WfCtx = Parameters<Parameters<typeof User.of<never>>[0]["Onboard"]>[0]
declare const wfCtx: WfCtx
const wfRoom = wfCtx.actors.get(Chat, RoomId.make("room-1"))
const waitForFirstMessage = () => wfCtx.waitFor(FirstMessage)
export const _wfSend: Eq<ReturnType<(typeof wfRoom)["SendMessage"]>, Effect.Effect<Message, InvalidMessage | NotAMember, never>> = true
export const _wfTranscript: Eq<ReturnType<(typeof wfRoom)["Transcript"]>, Stream.Stream<Message, NotAMember, never>> = true
export const _wfWait: Eq<ReturnType<typeof waitForFirstMessage>, Effect.Effect<Option.Option<FirstMessage>, never, never>> = true
// the owner handle inside a workflow reaches internal commands too (there is no turn to hold open)
export const _wfInternal: Eq<Parameters<WfCtx["owner"]["NoteMessage"]>[0], { readonly roomId: RoomId; readonly messageId: string }> = true

export const _programR: Eq<Effect.Services<typeof program>, Actors> = true
export const _counterLayer: Eq<typeof CounterLive, Layer.Layer<never, never, Actors>> = true
export const _chatLayer: Eq<typeof ChatLive, Layer.Layer<never, never, RoomAccess | Mailer | Actors>> = true
// queries never touch the entity: Database, plus whatever the handlers need
export const _chatReads: Eq<typeof ChatReads, Layer.Layer<never, never, RoomAccess | Database>> = true
export const _userLayer: Eq<typeof UserLive, Layer.Layer<never, never, Mailer | Actors>> = true
export const _nightlyLayer: Eq<typeof NightlyLive, Layer.Layer<never, never, Actors>> = true
export const _agentLayer: Eq<typeof AgentSessionLive, Layer.Layer<never, never, Model | Tools | Actors>> = true
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
export const _badInternal = E.gen(function*() {
  const room = yield* Chat.get(RoomId.make("room-1"))
  // @ts-expect-error MarkDelivered is internal: reachable from a turn or an executor, never from an outside handle
  yield* room.MarkDelivered({ messageId: "m1" })
})
// a handle resolved outside a turn needs only the runtime: the caller comes from `CurrentCaller`, which has a default
export const _call = E.flatMap(Counter.get(CounterId.make("c1")), (counter) => counter.Increment(1))
export const _callR: Eq<Effect.Services<typeof _call>, Actors> = true
export const _badIntent = (ctx: CounterCtx) =>
  // @ts-expect-error intents are not callable: send / after / at only
  ctx.self.Reset()
// @ts-expect-error cron cannot supply a payload, so it needs a zero-input command
export const _badCron = Cron.every("* * * * *", Increment)
export const _badForeignCron = Actor.make("ForeignCron", {
  id: CounterId,
  commands: [Increment],
  // @ts-expect-error Reset is not one of this actor's commands (decision 98)
  lifecycle: [Cron.every("0 * * * *", Reset)]
})
// request/reply inside a turn is a readable type error (decision 110): a handler that needs `Actors` does not compile
export const _badInsideTurn = Counter.toLayer({
  // @ts-expect-error use ctx.actors.get(Other, id).Command.send(...) instead of an outside handle
  Increment: (_ctx, n) => E.flatMap(Counter.get(CounterId.make("other")), (c) => c.Increment(n)),
  Reset: () => E.void
})
export const _badPerform = (ctx: ChatCtx) =>
  // @ts-expect-error MessageAdded is an event, not a declared effect
  ctx.perform(new MessageAdded({ message: {} as Message }))
export const _badEmit = (ctx: ChatCtx) =>
  // @ts-expect-error SendEmail is an effect, not a declared event
  ctx.emit(new SendEmail({ messageId: "m1", to: "a@b.c", body: "hi" }))
export const _badQueryEmit = (ctx: ChatQueryCtx) =>
  // @ts-expect-error query contexts cannot emit
  ctx.emit(new MessageAdded({ message: {} as Message }))
export const _badMemory = (ctx: CounterCtx) =>
  // @ts-expect-error per-activation state is `vars` or a closure in the server file, not a framework slot
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
export const _commandInQueries = Chat.toQueryLayer({ SendMessage: (_ctx, _input) => E.succeed({} as Message) })
export const _badWaitFor = () =>
  // @ts-expect-error CountChanged is not one of User's events
  wfCtx.waitFor(CountChanged)
export const _badActorsGet = E.gen(function*() {
  const actors = yield* Actors
  // @ts-expect-error CounterId is not a RoomId
  actors.get(Chat, CounterId.make("x"), { as: Caller.anonymous })
  // the branded form is the only one that compiles
  actors.get(Chat, RoomId.make("room-1"), { as: Caller.anonymous })
})
// @ts-expect-error a Principal is not a bare string
export const _badPrincipal = Actor.as("u1")
export const _schemaSanity: Eq<typeof Schema.String.Type, string> = true

// durable-actors/testing: the harness is typed per actor, so a test cannot inspect, crash or fail the wrong thing
type CounterTurn = TurnRecord<typeof Counter>
export const _turnExit: Eq<Extract<CounterTurn, { command: "Increment" }>["exit"], Exit.Exit<number, Overflow>> = true
export const _turnResetExit: Eq<Extract<CounterTurn, { command: "Reset" }>["exit"], Exit.Exit<void, never>> = true
export const _turnEmitted: Eq<CounterTurn["emitted"], ReadonlyArray<CountChanged>> = true
export const _turnId: Eq<CounterTurn["id"], CounterId> = true
// narrowing on `command` narrows `exit`, as a test would in a `switch`
export const _turnExitNarrow = (turn: CounterTurn) => turn.command === "Increment" ? turn.exit : null
export const _turnExitNarrowType: Eq<Exclude<ReturnType<typeof _turnExitNarrow>, null>, Exit.Exit<number, Overflow>> = true
export const _step: Eq<Step<typeof Counter>, { readonly command: "Increment"; readonly input: number; readonly commandId?: string } | { readonly command: "Reset"; readonly input: undefined; readonly commandId?: string }> = true
export const _deadLetter: Eq<ActorState<typeof Chat>["deadLetters"][number]["effect"], SendEmail> = true
export const _stateEvents: Eq<ActorState<typeof Chat>["events"][number]["event"], MessageAdded | import("./example/Chat.ts").EmailDelivered> = true
// `CurrentCaller` is a Reference set by the layer, not provided by it: it never shows up in the layer's output
export const _testLayer: Eq<ReturnType<typeof ActorTest.layer>, Layer.Layer<ActorTest | Actors | Database>> = true
const counterScripts = Scripts.arbitrary(Counter, { commands: ["Increment"] })
export const _scripts: Eq<typeof counterScripts, Arbitrary.Arbitrary<Script<typeof Counter>>> = true
declare const test: ActorTest["Service"]
// the bound form (decision 120): one call gives the handle, the ref and every harness operation for this id
const bound = test.actor(Counter, CounterId.make("c1"))
export const _boundHandle: Eq<Effect.Success<typeof bound>["handle"], CounterHandle> = true
export const _boundId: Eq<Effect.Success<typeof bound>["id"], CounterId> = true
// override infers the executor's requirements: a fake that needs a service surfaces it in R
export const _overrideR = test.effects.override(Chat, { SendEmail: () => E.flatMap(RoomAccess, () => E.void) })
export const _overrideRType: Eq<Effect.Services<typeof _overrideR>, Scope.Scope | RoomAccess> = true
export const _overrideNoR = test.effects.override(Chat, { SendEmail: () => E.void })
export const _overrideNoRType: Eq<Effect.Services<typeof _overrideNoR>, Scope.Scope> = true
// fakes see typed `ctx` and `effect`, not `any` (Eq is strict, so `any` fails here); `(ctx, effect)` like every handler
export const _overrideTyped = test.effects.override(Chat, {
  SendEmail: (ctx, effect) => {
    const _effect: Eq<typeof effect, SendEmail> = true
    const _ctx: Eq<typeof ctx, EffectContext<typeof Chat>> = true
    return E.log(effect.to.toUpperCase(), ctx.attempt.toFixed())
  }
})
// fakes written with Effect.fn / Effect.gen, a pretyped Partial, and two fakes needing different services
class FakeModel extends Context.Service<FakeModel, { readonly reply: (prompt: string) => Effect.Effect<string> }>()("test/FakeModel") {}
class FakeTools extends Context.Service<FakeTools, { readonly run: (name: string) => Effect.Effect<string> }>()("test/FakeTools") {}
export const _overrideFn = test.effects.override(AgentSession, {
  RunTool: E.fn(function*(ctx, effect) {
    const tools = yield* FakeTools
    const output = yield* tools.run(effect.name)
    // the executor's only way back into the actor is a durable intent
    yield* ctx.self.ToolFinished.send({ callId: effect.callId, output })
  })
})
export const _overrideFnType: Eq<Effect.Services<typeof _overrideFn>, Scope.Scope | FakeTools> = true
export const _overrideTwo = test.effects.override(CodingAgent, {
  RunPrompt: (_ctx, effect) => E.flatMap(FakeModel, (m) => E.asVoid(m.reply(effect.text))),
  StartSandbox: (_ctx, effect) => E.gen(function*() {
    const tools = yield* FakeTools
    yield* tools.run(effect.repo)
  })
})
export const _overrideTwoType: Eq<Effect.Services<typeof _overrideTwo>, Scope.Scope | FakeModel | FakeTools> = true
const pretyped: Partial<EffectExecutors<typeof Chat, RoomAccess>> = {}
export const _overridePretyped = test.effects.override(Chat, pretyped)
export const _overridePretypedType: Eq<Effect.Services<typeof _overridePretyped>, Scope.Scope | RoomAccess> = true
export const _overrideEmpty = test.effects.override(Chat, {})
export const _overrideEmptyType: Eq<Effect.Services<typeof _overrideEmpty>, Scope.Scope> = true
export const _badTesting = () => {
  // @ts-expect-error CounterId is not a RoomId
  test.inspect(Chat, CounterId.make("c1"))
  // @ts-expect-error Decrement is not a Counter command
  test.faults.crash(Counter, CounterId.make("c1"), { at: "before-commit", command: "Decrement" })
  // @ts-expect-error CountChanged is an event, not one of Chat's effects
  test.effects.fail(Chat, CountChanged, Cause.die("x"))
  // @ts-expect-error a Counter script cannot carry a Chat command
  test.run(Counter, CounterId.make("c1"), { steps: [{ command: "SendMessage", input: { body: "b" } }] })
  // @ts-expect-error RunTool is an AgentSession effect, not a Chat one: a stray key is rejected
  test.effects.override(Chat, { RunTool: () => E.void })
  // @ts-expect-error a fake must return an Effect
  test.effects.override(Chat, { SendEmail: () => 42 })
  // @ts-expect-error `effect` is a SendEmail: there is no `prompt`
  test.effects.override(Chat, { SendEmail: (_ctx, effect) => E.log(effect.prompt) })
  // @ts-expect-error `input` is not on the EffectContext (it is on the effect)
  test.effects.override(Chat, { SendEmail: (ctx) => E.log(ctx.input) })
  // @ts-expect-error the model's step sees typed steps: `input` on Reset is undefined
  const _m: TestModel<typeof Counter, number> = { initial: 0, step: (n, s) => s.command === "Reset" ? n + s.input : n, observe: () => E.succeed(0) }
}

// exported so the imports above are not elided
export type _Members = [typeof MarkDelivered, typeof RunTool, typeof ToolFinished]
