// Tools and MCP: the same actors, exposed to a coding agent with no extra glue.
import { Actor, type Auth, type Principal } from "../framework/Actor.ts"
import { Chat } from "./Chat.ts"
import { Counter } from "./Counter.ts"
import { Doc } from "./Doc.ts"

// a type error if any listed actor, public command or query lacks a description; internal commands and streams are excluded
export const AgentTools = Actor.toolkit([Chat, Counter, Doc], { maxOutputBytes: 32_000 })

// handlers: every tool call becomes `actor.get(id)` under the caller of the fiber that calls the tool + the command.
// Nothing to provide here: the caller is a per-call dependency of each tool (decision 145), not a layer input.
export const AgentToolsLive = AgentTools.layer

// Chat_SendMessage, Chat_Recent, Counter_Increment, Counter_Reset, Counter_GetCount, Doc_ApplyUpdate, Doc_Rename, Doc_Snapshot
export const toolNames = AgentTools.names

// the MCP endpoint authenticates every invocation with the same `Auth` the HTTP surface uses (decision 145)
export const mcpLive = <R>(auth: Auth<R>) =>
  Actor.mcp({
    actors: [Chat, Counter, Doc],
    name: "durable-actors",
    version: "1",
    transport: { _tag: "http", path: "/mcp", auth }
  })

// a local agent on stdio has no request to authenticate: the process says who it acts as
export const mcpStdio = (as: Principal) =>
  Actor.mcp({
    actors: [Chat, Counter, Doc],
    name: "durable-actors",
    version: "1",
    transport: { _tag: "stdio", as }
  })
