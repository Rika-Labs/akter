// Reference program: a coding-agent session. Prompts in, tokens out, tools in between.
import { Schedule, Schema } from "effect"
import { Actor, Effects, Hibernate } from "../framework/Actor.ts"

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

export class Token extends Schema.Class<Token>("Token")({
  turnId: Schema.String,
  text: Schema.String
}) {}
export class UnknownToolCall extends Schema.TaggedError<UnknownToolCall>()("UnknownToolCall", {
  callId: Schema.String
}, { httpApiStatus: 404 }) {}

export class TurnStarted extends Schema.TaggedClass<TurnStarted>()("TurnStarted", { turnId: Schema.String, prompt: Schema.String }) {}
export class ToolCalled extends Schema.TaggedClass<ToolCalled>()("ToolCalled", { callId: Schema.String, name: Schema.String }) {}
export class TurnFinished extends Schema.TaggedClass<TurnFinished>()("TurnFinished", { turnId: Schema.String, text: Schema.String }) {}

export class CallModel extends Schema.TaggedClass<CallModel>()("CallModel", { turnId: Schema.String, prompt: Schema.String }) {}
export class RunTool extends Schema.TaggedClass<RunTool>()("RunTool", { callId: Schema.String, name: Schema.String, args: Schema.String }) {}

export const turns = Actor.table("agent_turns", { id: "text", prompt: "text" })
export const toolCalls = Actor.table("agent_tool_calls", { id: "text", name: "text", state: "text" })

export const SendPrompt = Actor.command("SendPrompt", { input: { text: Schema.String }, output: Schema.String })
export const Cancel = Actor.command("Cancel")
export const ApproveTool = Actor.command("ApproveTool", { input: { callId: Schema.String }, errors: [UnknownToolCall] })
// internal: the effect executors send their results back as durable intents
export const ModelReplied = Actor.command("ModelReplied", { input: { turnId: Schema.String, text: Schema.String } })
export const ToolFinished = Actor.command("ToolFinished", { input: { callId: Schema.String, output: Schema.String } })

export const Tokens = Actor.stream("Tokens", { output: Token })

export const AgentSession = Actor.make("AgentSession", {
  id: SessionId,
  commands: [SendPrompt, Cancel, ApproveTool, ModelReplied, ToolFinished],
  streams: [Tokens],
  events: [TurnStarted, ToolCalled, TurnFinished],
  effects: [CallModel, RunTool],
  tables: [turns, toolCalls],
  lifecycle: [
    Hibernate.after("10 minutes"),
    Effects.retry(Schedule.exponential("500 millis"))
  ]
})
