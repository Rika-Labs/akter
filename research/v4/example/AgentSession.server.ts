// Server file: the model call and the tool run are effects; their results come back as intents.
import { Effect, Stream } from "effect"
import {
  AgentSession,
  CallModel,
  Token,
  ToolCalled,
  TurnFinished,
  TurnStarted,
  UnknownToolCall
} from "./AgentSession.ts"

export const AgentSessionLive = AgentSession.toLayer({
  SendPrompt: Effect.fn(function*(ctx, input) {
    const turnId = ctx.commandId
    yield* ctx.emit(new TurnStarted({ turnId, prompt: input.text }))
    yield* ctx.perform(new CallModel({ turnId, prompt: input.text }))
    return turnId
  }),
  Cancel: Effect.fn(function*(ctx) {
    // a cancelled session keeps no rows and no timers
    yield* ctx.terminate
  }),
  ApproveTool: Effect.fn(function*(ctx, input) {
    if (input.callId.length === 0) return yield* new UnknownToolCall({ callId: input.callId })
    yield* ctx.emit(new ToolCalled({ callId: input.callId, name: "bash" }))
  }),
  ModelReplied: Effect.fn(function*(ctx, input) {
    yield* ctx.emit(new TurnFinished({ turnId: input.turnId, text: input.text }))
  }),
  ToolFinished: Effect.fn(function*(ctx, input) {
    yield* ctx.emit(new ToolCalled({ callId: input.callId, name: input.output }))
  }),
  Tokens: (ctx) => Stream.fromIterable([new Token({ turnId: String(ctx.id), text: "" })])
}, {
  effects: {
    CallModel: (effect, ctx) =>
      Effect.gen(function*() {
        const text = `answer for ${effect.prompt} (attempt ${ctx.attempt})`
        yield* ctx.self.ModelReplied.send({ turnId: effect.turnId, text })
      }),
    RunTool: (effect, ctx) => ctx.self.ToolFinished.send({ callId: effect.callId, output: `ran ${effect.name} ${effect.args}` })
  },
  lifecycle: [
    AgentSession.onEffectFailed((ctx, effect, cause) =>
      Effect.logError(`session ${ctx.id}: ${effect._tag} gave up`, cause)
    )
  ]
})
