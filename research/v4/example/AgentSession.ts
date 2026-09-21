// Reference program: a coding-agent session. Prompts in, tokens out, tools in between.
import { Effect, Schedule, Schema } from "effect"
import { Actor, Commands, Effects, Hibernate } from "../framework/Actor.ts"

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

// a connection frame: one token of the model's answer
export class Token extends Schema.Class<Token>("Token")({
  turnId: Schema.String,
  text: Schema.String
}) {}

export class UnknownToolCall extends Schema.TaggedError<UnknownToolCall>()("UnknownToolCall", {
  callId: Schema.String
}, { httpApiStatus: 404 }) {
  override get message(): string {
    return `no tool call ${this.callId} in this session`
  }
}

export class PromptQueued extends Schema.TaggedClass<PromptQueued>()("PromptQueued", { turnId: Schema.String, prompt: Schema.String }) {}
export class TurnFinished extends Schema.TaggedClass<TurnFinished>()("TurnFinished", { turnId: Schema.String, text: Schema.String }) {}
export class ToolCalled extends Schema.TaggedClass<ToolCalled>()("ToolCalled", { callId: Schema.String, name: Schema.String }) {}
export class Cancelled extends Schema.TaggedClass<Cancelled>()("Cancelled", { turnId: Schema.String }) {}

// declared effect: the tool runs after commit, at least once
export class RunTool extends Schema.TaggedClass<RunTool>()("RunTool", { callId: Schema.String, name: Schema.String, args: Schema.String }) {}

export const toolCalls = Actor.table("agent_tool_calls", { id: "text", name: "text", state: "text" })

export const SendPrompt = Actor.command("SendPrompt", {
  description: "Queue a prompt for the model and return the turn id. The answer arrives on the Tokens connection.",
  input: { text: Schema.String },
  output: Schema.String
})
export const Cancel = Actor.command("Cancel", {
  description: "Cancel the given turn. A finished turn is unaffected.",
  input: { turnId: Schema.String }
})
export const ApproveTool = Actor.command("ApproveTool", {
  description: "Approve a pending tool call and run it. Fails with UnknownToolCall if the id is not pending.",
  input: { callId: Schema.String },
  errors: [UnknownToolCall]
})
// internal: the run loop and the executors send their results back as durable intents
export const ModelReplied = Actor.command("ModelReplied", {
  description: "Internal: the model finished a turn; records the answer and advances the event cursor.",
  input: { turnId: Schema.String, text: Schema.String, sequence: Schema.Number }
})
export const ToolFinished = Actor.command("ToolFinished", {
  description: "Internal: the tool executor finished; records its output.",
  input: { callId: Schema.String, output: Schema.String }
})

export const Tokens = Actor.connection("Tokens", {
  description: "Live token stream for this session. The actor pushes tokens; the client sends nothing.",
  server: Token
})

export const AgentSession = Actor.make("AgentSession", {
  description: "One coding-agent session: prompts are events, the model runs in the activation loop, tools are effects.",
  id: SessionId,
  commands: [SendPrompt, Cancel, ApproveTool, ModelReplied, ToolFinished],
  internal: [ModelReplied, ToolFinished],
  connections: [Tokens],
  events: [PromptQueued, TurnFinished, ToolCalled, Cancelled],
  effects: [RunTool],
  tables: [toolCalls],
  // the event cursor the run loop resumes from after a crash
  state: { processedUpTo: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))) },
  lifecycle: [
    Hibernate.after("10 minutes"),
    Commands.timeout("30 seconds"),
    Effects.retry(Schedule.exponential("500 millis"))
  ]
})
