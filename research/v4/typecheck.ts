// Type assertions for the proposed surface. `Eq` is strict: `any` is not equal to anything else.
// Run: bunx tsc --noEmit -p research/v4/tsconfig.json
import type { Duration, Effect, Layer, Scope, Stream } from "effect"
import { Effect as E } from "effect"
import type { ActorUnavailable, CommandConflict, IntentOptions } from "./framework/Actor.ts"
import { Actors, Cron } from "./framework/Actor.ts"
import { Chat, InvalidMessage, Message, MessageAdded, NotAMember, RoomId, SendEmail } from "./example/Chat.ts"
import { ChatLive, RoomAccess } from "./example/Chat.server.ts"
import { CountChanged, Counter, CounterId, Increment, Overflow } from "./example/Counter.ts"
import { CounterLive } from "./example/Counter.server.ts"
import { OnboardLive } from "./example/Onboard.server.ts"
import { AppLive, program, ticks } from "./example/usage.ts"

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
export const _sanity: Eq<any, string> = false

type CounterHandle = Effect.Success<ReturnType<typeof Counter.get>>
type ChatHandle = Effect.Success<ReturnType<typeof Chat.get>>
// the handler context types, as the server file sees them
type CounterCtx = Parameters<Parameters<typeof Counter.of>[0]["Increment"]>[0]
type ChatCtx = Parameters<Parameters<typeof Chat.of>[0]["SendMessage"]>[0]
type ChatQueryCtx = Parameters<Parameters<typeof Chat.of>[0]["Recent"]>[0]

export const _get: Eq<ReturnType<typeof Counter.get>, Effect.Effect<CounterHandle, never, Actors>> = true
export const _getArgs: Eq<Parameters<typeof Counter.get>[0], CounterId> = true
export const _inc: Eq<ReturnType<CounterHandle["Increment"]>, Effect.Effect<number, Overflow | CommandConflict | ActorUnavailable>> = true
export const _incArgs: Eq<Parameters<CounterHandle["Increment"]>, [input: number]> = true
export const _reset: Eq<ReturnType<CounterHandle["Reset"]>, Effect.Effect<void, CommandConflict | ActorUnavailable>> = true
export const _resetArgs: Eq<Parameters<CounterHandle["Reset"]>, []> = true
// queries run on the caller's node: no Cluster hop, so no ActorUnavailable
export const _getCount: Eq<ReturnType<CounterHandle["GetCount"]>, Effect.Effect<number, never>> = true
export const _recent: Eq<ReturnType<ChatHandle["Recent"]>, Effect.Effect<ReadonlyArray<Message>, NotAMember>> = true
export const _transcript: Eq<ReturnType<ChatHandle["Transcript"]>, Stream.Stream<Message, NotAMember | ActorUnavailable>> = true
export const _events: Eq<ReturnType<CounterHandle["events"]>, Stream.Stream<CountChanged, never, Scope.Scope>> = true
export const _ticks: Eq<Effect.Success<typeof ticks>, Stream.Stream<CountChanged, never, Scope.Scope>> = true
export const _sendArgs: Eq<Parameters<ChatHandle["SendMessage"]>[0], { readonly id: string; readonly body: string }> = true
export const _sendOut: Eq<Effect.Success<ReturnType<ChatHandle["SendMessage"]>>, Message> = true

// intents exist only inside a turn, on `ctx.self` / `ctx.actors`
export const _selfAfter: Eq<CounterCtx["self"]["Reset"]["after"], (delay: Duration.Input, options?: IntentOptions) => Effect.Effect<void>> = true
export const _selfSend: Eq<CounterCtx["self"]["Increment"]["send"], (input: number, options?: IntentOptions) => Effect.Effect<void>> = true

export const _programR: Eq<Effect.Services<typeof program>, Actors> = true
export const _counterLayer: Eq<typeof CounterLive, Layer.Layer<never, never, Actors>> = true
export const _chatLayer: Eq<typeof ChatLive, Layer.Layer<never, never, RoomAccess | Actors>> = true
export const _onboardLayer: Eq<typeof OnboardLive, Layer.Layer<never, never, Actors>> = true
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
export const _badHandlers = Counter.toLayer({
  // @ts-expect-error InvalidMessage is not declared on Increment
  Increment: (_ctx, _n) => E.fail(new InvalidMessage({ reason: "empty" })),
  Reset: () => E.void,
  GetCount: () => E.succeed(0)
})
// @ts-expect-error handlers are missing
export const _missingHandlers = Counter.toLayer({})
export const _badActorsGet = E.gen(function*() {
  const actors = yield* Actors
  // @ts-expect-error CounterId is not a RoomId
  actors.get(Chat, CounterId.make("x"))
  // the branded form is the only one that compiles
  actors.get(Chat, RoomId.make("room-1"))
})
