// Tools and MCP: the same actors, exposed to a coding agent with no extra glue.
import { Actor } from "../framework/Actor.ts"
import { Chat } from "./Chat.ts"
import { Counter } from "./Counter.ts"
import { Doc } from "./Doc.ts"

// a type error if any listed actor, public command or query lacks a description; internal commands and streams are excluded
export const AgentTools = Actor.toolkit([Chat, Counter, Doc], { maxOutputBytes: 32_000 })

// handlers: every tool call becomes `actor.get(id, { as: CurrentCaller })` + the command
export const AgentToolsLive = AgentTools.layer

// Chat_SendMessage, Chat_Recent, Counter_Increment, Counter_Reset, Counter_GetCount, Doc_ApplyUpdate, Doc_Rename, Doc_Snapshot
export const toolNames = AgentTools.names

export const McpLive = Actor.mcp({
  actors: [Chat, Counter, Doc],
  name: "durable-actors",
  version: "1",
  transport: { path: "/mcp" } // served by Actor.serve; `"stdio"` for a local agent instead
})
