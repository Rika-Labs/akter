// The whole process: actor layers, their services, the HTTP entrypoint, the cluster runtime and the database.
import { Effect, Layer, Stream } from "effect"
import { Actor, Database, TenantId, Topology } from "../framework/Actor.ts"
import { mcpLive } from "./agent.ts"
import { AgentSession } from "./AgentSession.ts"
import { AgentSessionLive, Model, Tools } from "./AgentSession.server.ts"
import { Chat } from "./Chat.ts"
import { ChatReads } from "./Chat.queries.ts"
import { ChatLive, RoomAccess } from "./Chat.server.ts"
import { Counter } from "./Counter.ts"
import { CounterLive, CounterReads } from "./Counter.server.ts"
import { Cursor } from "./Cursor.ts"
import { CursorLive } from "./Cursor.server.ts"
import { Doc } from "./Doc.ts"
import { DocLive, DocReads } from "./Doc.server.ts"
import { MailerLive } from "./Mailer.ts"
import { NightlyLive } from "./Nightly.server.ts"
import { Onboard } from "./Onboard.ts"
import { OnboardLive } from "./Onboard.server.ts"
import { NotAMember } from "./Chat.ts"
import { PrincipalSchema, OrgId, UserId } from "./Principal.ts"
import { ReaperLive } from "./Reaper.server.ts"

// the real one verifies a JWT and fails with `new Unauthorized({ reason: "invalid_credentials" })`
const verify = (token: string) =>
  Effect.succeed({ userId: UserId.make(token), orgId: OrgId.make("acme"), roles: ["member"] as const })
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

export const AppLive = Layer.mergeAll(
  ChatLive,
  ChatReads,
  CounterLive,
  CounterReads,
  AgentSessionLive,
  CursorLive,
  DocLive,
  DocReads,
  OnboardLive,
  NightlyLive,
  ReaperLive
).pipe(
  Layer.provide(Layer.mergeAll(RoomAccessLive, MailerLive, ModelLive, ToolsLive)),
  Layer.provideMerge(Actor.serve({
    actors: [Chat, Counter, AgentSession, Cursor, Doc],
    workflows: [Onboard],
    auth,
    docs: true // /llms.txt, /openapi.json, /actors/Chat.md
  })),
  // same `auth` on the MCP endpoint: every tool invocation runs as the authenticated principal (decision 145)
  Layer.provideMerge(mcpLive(auth)),
  Layer.provide(Actor.layer({
    principal: PrincipalSchema,
    tenant: (p) => TenantId.make(p.orgId), // one tenant per org, derived once
    topology: Topology.fromConfig(), // ACTORS_TOPOLOGY=single|http|k8s
    shardGroup: (tenant) => tenant.startsWith("eu-") ? "eu" : "default",
    pollInterval: "1 second"
  })),
  Layer.provide(Database.layerConfig()) // DATABASE_URL (Redacted), DATABASE_NEKI, DATABASE_MIGRATE
)

export const main = Layer.launch(AppLive)
