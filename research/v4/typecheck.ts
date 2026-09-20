// Type assertions for the proposed surface. `Eq` is strict: `any` is not equal to anything else.
// Run: bunx tsc --noEmit -p research/v4/tsconfig.json
import type { Duration, Effect, Layer, Scope, Stream } from "effect"
import { Effect as E } from "effect"
import { type ActorUnavailable, type CallOptions, type CommandConflict, type CommandContext, type HandleOf, type Turn, Actors } from "./framework/Actor.ts"
import { Chat, InvalidMessage, Message, MessageAdded, NotAMember } from "./example/Chat.ts"
import { ChatLive, RoomAccess } from "./example/Chat.server.ts"
import { CountChanged, Counter, Overflow } from "./example/Counter.ts"
import { CounterLive } from "./example/Counter.server.ts"
import { AppLive, program, ticks } from "./example/usage.ts"

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
export const _sanity: Eq<any, string> = false

type CounterHandle = Effect.Success<ReturnType<typeof Counter.get>>
export const _get: Eq<ReturnType<typeof Counter.get>, Effect.Effect<CounterHandle, never, Actors>> = true
export const _inc: Eq<ReturnType<CounterHandle["Increment"]>, Effect.Effect<number, Overflow | CommandConflict | ActorUnavailable>> = true
export const _incArgs: Eq<Parameters<CounterHandle["Increment"]>, [input: number, options?: CallOptions]> = true
export const _resetArgs: Eq<Parameters<CounterHandle["Reset"]>, [options?: CallOptions]> = true
export const _getCount: Eq<ReturnType<CounterHandle["GetCount"]>, Effect.Effect<number, ActorUnavailable>> = true
export const _after: Eq<ReturnType<CounterHandle["Reset"]["after"]>, Effect.Effect<void, never, Turn>> = true
export const _afterArgs: Eq<Parameters<CounterHandle["Increment"]["after"]>, [delay: Duration.Input, input: number]> = true
export const _sameHandle: Eq<HandleOf<typeof Counter>, CounterHandle> = true
export const _programE: Eq<Effect.Error<typeof program>, Overflow | CommandConflict | ActorUnavailable | InvalidMessage | NotAMember> = true
export const _programR: Eq<Effect.Services<typeof program>, Actors> = true
export const _ticks: Eq<Effect.Success<typeof ticks>, Stream.Stream<CountChanged, never, Scope.Scope>> = true
export const _counterLayerR: Eq<Layer.Services<typeof CounterLive>, Actors> = true
export const _chatLayerR: Eq<Layer.Services<typeof ChatLive>, RoomAccess | Actors> = true
export const _appR: Eq<Layer.Services<typeof AppLive>, never> = true

type ChatHandle = Effect.Success<ReturnType<typeof Chat.get>>
export const _sendArgs: Eq<Parameters<ChatHandle["SendMessage"]>[0], { readonly id: string; readonly body: string }> = true
export const _sendOut: Eq<Effect.Success<ReturnType<ChatHandle["SendMessage"]>>, Message> = true
export const _recent: Eq<ReturnType<ChatHandle["Recent"]>, Effect.Effect<ReadonlyArray<Message>, NotAMember | ActorUnavailable>> = true

// negatives: each line must fail to compile
export const _badHandlers = Counter.toLayer({
  // @ts-expect-error InvalidMessage is not declared on Increment
  Increment: (_ctx, _n) => E.fail(new InvalidMessage({ reason: "empty" })),
  Reset: () => E.void,
  GetCount: () => E.succeed(0)
})
export const _badCalls = E.gen(function*() {
  const counter = yield* Counter.get("x")
  // @ts-expect-error Increment takes a number
  yield* counter.Increment("1")
  // @ts-expect-error unknown command
  yield* counter.Decrement(1)
  // @ts-expect-error Reset takes no input
  yield* counter.Reset.after("1 hour", 1)
  // @ts-expect-error .send needs a Turn; program-level R would become Turn
  const _: E.Effect<void, never, Actors> = counter.Reset.send()
})
export const _badEmit = (ctx: CommandContext<typeof CountChanged, unknown>) =>
  // @ts-expect-error MessageAdded is not a Counter event
  ctx.emit(new MessageAdded({ message: {} as Message }))
export const _badSelfAssign = E.gen(function*() {
  const counter = yield* Counter.get("x")
  // @ts-expect-error Chat handle is not a Counter handle
  const _: HandleOf<typeof Chat> = counter
})
