// Server file: the turn is a transaction, the model call is the run loop, the tool run is an effect.
import { Context, Effect, Option, Stream } from "effect"
import {
  AgentSession,
  Cancelled,
  PromptQueued,
  RunTool,
  Token,
  ToolCalled,
  toolCalls,
  TurnFinished,
  UnknownToolCall
} from "./AgentSession.ts"

export class Model extends Context.Service<Model, {
  readonly stream: (prompt: string) => Stream.Stream<string>
}>()("app/Model") {}

export class Tools extends Context.Service<Tools, {
  readonly run: (name: string, args: string) => Effect.Effect<string>
}>()("app/Tools") {}

export const AgentSessionLive = AgentSession.toLayer(
  Effect.gen(function*() {
    const model = yield* Model
    const tools = yield* Tools

    return AgentSession.of({
      // the turn is one transaction; the model call happens in the run loop, outside it
      SendPrompt: (ctx, { text }) =>
        ctx.emit(new PromptQueued({ turnId: ctx.commandId, prompt: text })).pipe(Effect.as(ctx.commandId)),
      Cancel: (ctx, { turnId }) => ctx.emit(new Cancelled({ turnId })),
      ApproveTool: Effect.fn(function*(ctx, { callId }) {
        const row = yield* ctx.rows(toolCalls).one({ where: { id: callId } })
        if (Option.isNone(row)) return yield* new UnknownToolCall({ callId })
        yield* ctx.rows(toolCalls).update({ state: "approved" }, { where: { id: callId } })
        yield* ctx.perform(new RunTool({ callId, name: row.value.name, args: "" }))
        yield* ctx.emit(new ToolCalled({ callId, name: row.value.name }))
      }),
      ModelReplied: Effect.fn(function*(ctx, { turnId, text, sequence }) {
        yield* ctx.emit(new TurnFinished({ turnId, text }))
        yield* ctx.state.set({ processedUpTo: sequence }) // the cursor the run loop resumes from
      }),
      ToolFinished: (ctx, { callId }) => ctx.rows(toolCalls).update({ state: "done" }, { where: { id: callId } }),
      // tokens arrive via broadcast from the run loop; the handler only keeps the session open
      Tokens: (_ctx, inbound) => inbound.pipe(Stream.drain)
    }, {
      hooks: [
        AgentSession.onEffectFailed((_ctx, effect, cause) => Effect.logError(`${effect._tag} gave up`, cause))
      ],
      effects: {
        RunTool: (ctx, effect) =>
          tools.run(effect.name, effect.args).pipe(
            Effect.flatMap((output) => ctx.self.ToolFinished.send({ callId: effect.callId, output }))
          )
      },
      // no transaction and no `rows` writes here: durable changes are intents, so a crash replays from `processedUpTo`
      run: (ctx) =>
        ctx.events(PromptQueued, { after: ctx.state.processedUpTo }).pipe(
          Stream.mapEffect((e) =>
            model.stream(e.event.prompt).pipe(
              Stream.tap((token) => ctx.connections.broadcast(new Token({ turnId: e.event.turnId, text: token }))),
              Stream.mkString,
              Effect.flatMap((text) => ctx.self.ModelReplied.send({ turnId: e.event.turnId, text, sequence: e.sequence })),
              Effect.raceFirst(
                ctx.events(Cancelled).pipe(
                  Stream.filter((c) => c.event.turnId === e.event.turnId),
                  Stream.runHead,
                  Effect.asVoid
                )
              )
            )
          ),
          Stream.runDrain,
          Effect.catchCause(Effect.logError)
        )
    })
  })
)
