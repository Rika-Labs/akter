// The whole process: actor layers, their services, the HTTP entrypoint, the cluster runtime and the database.
// Three ways to run this (decision 155): embedded (this layer inside the app's own process), served (this file as its
// own process), hosted (the same layers on our runners). Only `Actor.serve` differs: leave it out to embed.
import { Effect, Layer, Stream } from "effect"
import { Actor, Database, TenantId, Topology, Unauthorized } from "../framework/Actor.ts"
import { AgentSession } from "./AgentSession.ts"
import { AgentSessionLive, Model, Tools } from "./AgentSession.server.ts"
import { Chat, NotAMember } from "./Chat.ts"
import { ChatReads } from "./Chat.queries.ts"
import { ChatLive, RoomAccess } from "./Chat.server.ts"
import { CodingAgent } from "./CodingAgent.ts"
import { CodingAgentLive, CodingAgentReads } from "./CodingAgent.server.ts"
import { Counter } from "./Counter.ts"
import { CounterLive, CounterReads } from "./Counter.server.ts"
import { Cursor } from "./Cursor.ts"
import { CursorLive } from "./Cursor.server.ts"
import { Doc } from "./Doc.ts"
import { DocLive, DocReads } from "./Doc.server.ts"
import { MailerLive } from "./Mailer.ts"
import { Nightly } from "./Nightly.ts"
import { NightlyLive } from "./Nightly.server.ts"
import { OrgId, PrincipalSchema, UserId } from "./Principal.ts"
import { Reaper } from "./Reaper.ts"
import { ReaperLive } from "./Reaper.server.ts"
import { SandboxReaper } from "./SandboxReaper.ts"
import { SandboxReaperLive } from "./SandboxReaper.server.ts"
import type { E2BSdk, OpenCodeSdk } from "./services.ts"
import { OpenCodeLive, SandboxesLive } from "./services.ts"
import { User } from "./User.ts"
import { UserLive } from "./User.server.ts"

// the real one verifies a JWT; an invalid token fails with `new Unauthorized({ code: "invalid_credentials" })`
const verify = (token: string) =>
  token.length === 0
    ? Effect.fail(new Unauthorized({ code: "invalid_credentials" }))
    : Effect.succeed({ userId: UserId.make(token), orgId: OrgId.make("acme"), roles: ["member"] as const })
const auth = Actor.auth.bearer(verify)

// membership is an application concern: `User` callers need the role, `System` callers (timers, cron, workflows) pass
const RoomAccessLive = Layer.succeed(RoomAccess, {
  requireMember: (caller, room) =>
    caller._tag !== "User" || caller.principal.roles.includes("member")
      ? Effect.void
      : Effect.fail(new NotAMember({ userId: `${caller.principal.userId} in ${room}` }))
})
const ModelLive = Layer.succeed(Model, { stream: (prompt) => Stream.make(...prompt.split(" ")) })
const ToolsLive = Layer.succeed(Tools, { run: (name, args) => Effect.succeed(`${name}(${args})`) })
// real code: `import { Sandbox } from "e2b"` and `import { createOpencodeClient } from "@opencode-ai/sdk/v2"`
declare const e2b: E2BSdk
declare const opencodeSdk: OpenCodeSdk

export const AppLive = Layer.mergeAll(
  ChatLive,
  ChatReads,
  CounterLive,
  CounterReads,
  AgentSessionLive,
  CursorLive,
  DocLive,
  DocReads,
  UserLive,
  CodingAgentLive,
  CodingAgentReads,
  NightlyLive,
  ReaperLive,
  SandboxReaperLive
).pipe(
  Layer.provide(Layer.mergeAll(RoomAccessLive, MailerLive, ModelLive, ToolsLive, SandboxesLive(e2b), OpenCodeLive(opencodeSdk))),
  // the optional HTTP entrypoint: every public member of every listed actor, plus /openapi.json. Singletons are listed
  // too: `Reaper.get().Pause()` is reachable over HTTP as /actors/Reaper/singleton/Pause
  Layer.provideMerge(Actor.serve({
    actors: [Chat, Counter, AgentSession, Cursor, Doc, User, CodingAgent, Nightly, Reaper, SandboxReaper],
    auth
  })),
  Layer.provide(Actor.layer({
    principal: PrincipalSchema,
    tenant: (p) => TenantId.make(p.orgId), // one tenant per org, derived once
    topology: Topology.fromConfig(), // ACTORS_TOPOLOGY=single|http
    shardGroup: (tenant) => tenant.startsWith("eu-") ? "eu" : "default",
    pollInterval: "1 second"
  })),
  Layer.provide(Database.layerConfig()) // DATABASE_URL (Redacted), DATABASE_NEKI, DATABASE_MIGRATE
)

export const main = Layer.launch(AppLive)
