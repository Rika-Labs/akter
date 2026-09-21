// Application services for the CodingAgent example: E2B sandboxes and an OpenCode server inside one.
//
// The framework ships nothing AI- or sandbox-specific (decision 153); these are ordinary Effect services the app writes
// once. They wrap the Promise SDKs (`e2b`, `@opencode-ai/sdk/v2`) with `Effect.tryPromise` and tagged errors so the
// actor's executors and run loop see typed failures. The SDK types below are structural copies of the verified
// surface (e2b: `Sandbox.create/connect/kill/list`, `sandbox.pause/getHost/commands.run`; opencode v2:
// `createOpencodeClient`, `session.create/promptAsync/abort`, `event.subscribe().stream`) so this sketch typechecks
// without the packages installed. Real code imports them.
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"

export const SandboxId = Schema.String.pipe(Schema.brand("SandboxId"))
export type SandboxId = typeof SandboxId.Type
export const OpenCodeSessionId = Schema.String.pipe(Schema.brand("OpenCodeSessionId"))
export type OpenCodeSessionId = typeof OpenCodeSessionId.Type

export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  op: Schema.Literals(["create", "connect", "pause", "kill", "list", "exec"]),
  reason: Schema.String
}) {
  override get message(): string {
    return `sandbox ${this.op} failed: ${this.reason}`
  }
}
/** `connect` on a sandbox that no longer exists (killed, expired): the actor treats it as "start over", not "retry". */
export class SandboxGone extends Schema.TaggedError<SandboxGone>()("SandboxGone", { sandboxId: SandboxId }) {
  override get message(): string {
    return `sandbox ${this.sandboxId} no longer exists`
  }
}
export class OpenCodeError extends Schema.TaggedError<OpenCodeError>()("OpenCodeError", {
  op: Schema.Literals(["session", "prompt", "abort", "events"]),
  reason: Schema.String
}) {
  override get message(): string {
    return `opencode ${this.op} failed: ${this.reason}`
  }
}

/** The subset of OpenCode's event bus the actor follows: text deltas and the end of a turn. */
export type OpenCodeEvent =
  | { readonly _tag: "Delta"; readonly sessionId: OpenCodeSessionId; readonly text: string }
  | { readonly _tag: "Idle"; readonly sessionId: OpenCodeSessionId }
  | { readonly _tag: "Error"; readonly sessionId: OpenCodeSessionId; readonly reason: string }

export interface SandboxInfo {
  readonly id: SandboxId
  /** `sandbox.getHost(4096)`: where the OpenCode server inside it listens */
  readonly host: string
}

/** E2B sandboxes as an Effect service. `connect` resumes a paused sandbox (E2B does this itself). */
export class Sandboxes extends Context.Service<Sandboxes, {
  readonly create: (options: { readonly repo: string }) => Effect.Effect<SandboxInfo, SandboxError>
  readonly connect: (id: SandboxId) => Effect.Effect<SandboxInfo, SandboxError | SandboxGone>
  readonly pause: (id: SandboxId) => Effect.Effect<void, SandboxError>
  readonly kill: (id: SandboxId) => Effect.Effect<void, SandboxError>
  readonly list: Effect.Effect<ReadonlyArray<{ readonly id: SandboxId; readonly startedAt: Date }>, SandboxError>
}>()("app/Sandboxes") {}

/** One OpenCode server (`opencode serve --port 4096` inside the sandbox) as an Effect service. */
export interface OpenCodeClient {
  readonly createSession: Effect.Effect<OpenCodeSessionId, OpenCodeError>
  /** `session.promptAsync`: returns as soon as the prompt is queued; the answer arrives on `events` */
  readonly prompt: (session: OpenCodeSessionId, text: string) => Effect.Effect<void, OpenCodeError>
  readonly abort: (session: OpenCodeSessionId) => Effect.Effect<void, OpenCodeError>
  /** `event.subscribe().stream`, narrowed to the three events the actor cares about */
  readonly events: Stream.Stream<OpenCodeEvent, OpenCodeError>
}
export class OpenCode extends Context.Service<OpenCode, {
  readonly connect: (host: string) => OpenCodeClient
}>()("app/OpenCode") {}

// ---------------------------------------------------------------------------------------------------
// Live layers over the Promise SDKs. Structural SDK types stand in for `import { Sandbox } from "e2b"` and
// `import { createOpencodeClient } from "@opencode-ai/sdk/v2"` so the sketch typechecks without the packages.
// ---------------------------------------------------------------------------------------------------

export interface E2BSandbox {
  readonly sandboxId: string
  readonly getHost: (port: number) => string
  readonly pause: () => Promise<void>
  readonly commands: { readonly run: (cmd: string, options?: { readonly background?: boolean }) => Promise<unknown> }
}
export interface E2BSdk {
  readonly create: (template?: string) => Promise<E2BSandbox>
  readonly connect: (sandboxId: string) => Promise<E2BSandbox>
  readonly kill: (sandboxId: string) => Promise<void>
  readonly list: () => Promise<ReadonlyArray<{ readonly sandboxId: string; readonly startedAt: Date }>>
}
export interface OpenCodeSdk {
  readonly createOpencodeClient: (options: { readonly baseUrl: string }) => {
    readonly session: {
      readonly create: (body: {}, options: { readonly throwOnError: true }) => Promise<{ readonly data: { readonly id: string } }>
      readonly promptAsync: (body: { readonly sessionID: string; readonly parts: ReadonlyArray<{ readonly type: "text"; readonly text: string }> }) => Promise<unknown>
      readonly abort: (body: { readonly sessionID: string }) => Promise<unknown>
    }
    readonly event: {
      readonly subscribe: () => Promise<{ readonly stream: AsyncIterable<{ readonly type: string; readonly properties: any }> }>
    }
  }
}

const isNotFound = (e: unknown) => e instanceof Error && /not found|404/i.test(e.message)
const reason = (e: unknown) => e instanceof Error ? e.message : String(e)

/** `Sandboxes` over the `e2b` package. The OpenCode server is started once per sandbox, in the background. */
export const SandboxesLive = (sdk: E2BSdk) =>
  Layer.succeed(Sandboxes, {
    create: ({ repo }) =>
      Effect.tryPromise({
        try: async () => {
          const sb = await sdk.create()
          await sb.commands.run(`git clone ${repo} /home/user/repo`)
          await sb.commands.run("cd /home/user/repo && opencode serve --port 4096", { background: true })
          return { id: SandboxId.make(sb.sandboxId), host: sb.getHost(4096) }
        },
        catch: (e) => new SandboxError({ op: "create", reason: reason(e) })
      }),
    connect: (id) =>
      Effect.tryPromise({
        try: () => sdk.connect(id),
        catch: (e) => isNotFound(e) ? new SandboxGone({ sandboxId: id }) : new SandboxError({ op: "connect", reason: reason(e) })
      }).pipe(Effect.map((sb) => ({ id, host: sb.getHost(4096) }))),
    pause: (id) =>
      Effect.tryPromise({
        try: async () => {
          const sb = await sdk.connect(id)
          await sb.pause()
        },
        catch: (e) => new SandboxError({ op: "pause", reason: reason(e) })
      }),
    kill: (id) => Effect.tryPromise({ try: () => sdk.kill(id), catch: (e) => new SandboxError({ op: "kill", reason: reason(e) }) }),
    list: Effect.tryPromise({
      try: () => sdk.list(),
      catch: (e) => new SandboxError({ op: "list", reason: reason(e) })
    }).pipe(Effect.map((all) => all.map((s) => ({ id: SandboxId.make(s.sandboxId), startedAt: s.startedAt }))))
  })

/** `OpenCode` over `@opencode-ai/sdk/v2`. The private Effect client (`@opencode-ai/client/effect`) would replace this file's body with a `Stream` it already provides. */
export const OpenCodeLive = (sdk: OpenCodeSdk) =>
  Layer.succeed(OpenCode, {
    connect: (host) => {
      const client = sdk.createOpencodeClient({ baseUrl: `https://${host}` })
      return {
        createSession: Effect.tryPromise({
          try: () => client.session.create({}, { throwOnError: true }),
          catch: (e) => new OpenCodeError({ op: "session", reason: reason(e) })
        }).pipe(Effect.map((r) => OpenCodeSessionId.make(r.data.id))),
        prompt: (sessionID, text) =>
          Effect.tryPromise({
            try: () => client.session.promptAsync({ sessionID, parts: [{ type: "text", text }] }),
            catch: (e) => new OpenCodeError({ op: "prompt", reason: reason(e) })
          }).pipe(Effect.asVoid),
        abort: (sessionID) =>
          Effect.tryPromise({
            try: () => client.session.abort({ sessionID }),
            catch: (e) => new OpenCodeError({ op: "abort", reason: reason(e) })
          }).pipe(Effect.asVoid),
        events: Stream.unwrap(
          Effect.tryPromise({
            try: () => client.event.subscribe(),
            catch: (e) => new OpenCodeError({ op: "events", reason: reason(e) })
          }).pipe(
            Effect.map((sub) =>
              Stream.fromAsyncIterable(sub.stream, (e) => new OpenCodeError({ op: "events", reason: reason(e) })).pipe(
                Stream.map((ev): Option.Option<OpenCodeEvent> => {
                  const sessionId = OpenCodeSessionId.make(ev.properties?.sessionID ?? ev.properties?.part?.sessionID ?? "")
                  switch (ev.type) {
                    case "message.part.delta":
                      return Option.some({ _tag: "Delta", sessionId, text: String(ev.properties.delta ?? "") })
                    case "session.idle":
                      return Option.some({ _tag: "Idle", sessionId })
                    case "session.error":
                      return Option.some({ _tag: "Error", sessionId, reason: String(ev.properties.error?.data?.message ?? "unknown") })
                    default:
                      return Option.none()
                  }
                }),
                Stream.filter(Option.isSome),
                Stream.map((o) => o.value)
              )
            )
          )
        )
      }
    }
  })
