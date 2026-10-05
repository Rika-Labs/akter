import { Context, Crypto, Effect, Schema } from "effect"
import { DeploymentId, Region } from "../tenant-home/contract.ts"

/** An environment variable name, as a shell and the container runtimes accept it. */
const EnvironmentName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,254}$/u))

/**
 * What a runner is started from. `idempotencyKey` is any non-empty string the
 * caller derives from the start it is retrying, such as a job id: a repeat
 * with the same key for the same deployment returns the runner the first call
 * made, and a replacement runner takes a new key. The platform keeps no
 * record; it hashes the deployment and key into the provider's own token (see
 * `startToken`).
 *
 * `environment` is the complete snapshot the process starts with. Values may
 * be secrets and never appear in errors or logs.
 */
export const StartInput = Schema.Struct({
  deploymentId: DeploymentId,
  region: Region,
  image: Schema.String.check(Schema.isPattern(/^[^\s]{1,1024}$/u)),
  environment: Schema.Record(Schema.String, Schema.String).check(
    Schema.isPropertyNames(EnvironmentName),
  ),
  idempotencyKey: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
})

export type StartInput = typeof StartInput.Type

/**
 * `starting` is a process the platform has accepted but that is not running
 * yet; `running` means it exists, not that it serves, because the edge decides
 * readiness by probing the runner's `GET /ready`. `stopped` covers a process
 * that is draining as well as one that has exited: neither takes traffic.
 */
export type RunnerState = "starting" | "running" | "stopped"

/**
 * A runner as the platform reports it. `id` names it in `describe` and
 * `stop`. `url` is the origin the edge forwards to (`scheme://host[:port]`, no
 * path), null until the platform has assigned an address. `basePath` is where
 * the runner's `Actor.serve` mounts its routes, for `deployment_runner`.
 */
export interface Runner {
  readonly id: string
  readonly state: RunnerState
  readonly url: string | null
  readonly basePath: string
  /** True only when the provider has observed process termination, rather than a requested drain. */
  readonly terminated?: boolean
}

/** The platform has no runner with this id. */
export class RunnerNotFound extends Schema.TaggedError<RunnerNotFound>()("RunnerNotFound", {
  id: Schema.String,
}) {}

const Code = Schema.Literals([
  "invalid-input",
  "unknown-region",
  "unavailable",
  "capacity",
  "refused",
  "no-task",
  "unreadable",
])

type Code = typeof Code.Type

const reasons = {
  "invalid-input": "the start request is invalid",
  "unknown-region": "no placement is configured for the region",
  unavailable: "the platform could not be reached",
  capacity: "the platform has no capacity for the runner in an allowed region",
  refused: "the platform refused the request",
  "no-task": "the platform started no runner",
  unreadable: "the platform's answer could not be read",
} satisfies Record<Code, string>

/**
 * The platform refused or failed an operation. `code` is one of a fixed set
 * and `message` is its fixed sentence, optionally followed by the provider's
 * own error name in parentheses. Nothing the provider or a child process said
 * is copied in, because it can echo the request, and the request carries
 * secrets. `unavailable` and `capacity` are transient: the same start can
 * succeed when retried later.
 */
export class RunnerPlatformError extends Schema.TaggedError<RunnerPlatformError>()(
  "RunnerPlatformError",
  {
    operation: Schema.Literals(["start", "describe", "stop"]),
    code: Code,
    message: Schema.String,
  },
) {}

/** A `RunnerPlatformError` with the fixed sentence for `code`; `name` must be a provider's fixed error name. */
export const platformError = (failure: {
  readonly operation: "start" | "describe" | "stop"
  readonly code: Code
  readonly name?: string | undefined
}) =>
  RunnerPlatformError.make({
    operation: failure.operation,
    code: failure.code,
    message:
      failure.name === undefined
        ? reasons[failure.code]
        : `${reasons[failure.code]} (${failure.name})`,
  })

/**
 * Starts, observes and stops one runner process at a time. The service keeps
 * no state of its own: which runners should exist, when to replace them and
 * what to register with the edge belong to the actor that calls it.
 */
export class RunnerPlatform extends Context.Service<
  RunnerPlatform,
  {
    /**
     * Starts the runner and returns once the platform has accepted it, usually
     * before it has an address.
     */
    readonly start: (input: StartInput) => Effect.Effect<Runner, RunnerPlatformError>

    /** Reads the runner's current state and address. */
    readonly describe: (id: string) => Effect.Effect<Runner, RunnerNotFound | RunnerPlatformError>

    /**
     * Asks the runner to drain: the platform sends SIGTERM, which runs
     * `RuntimeControl.drain`, and kills the process only after its own grace
     * period. It resolves after the provider observes termination, not merely
     * after a stop request is accepted. Stopping a stopped runner succeeds.
     */
    readonly stop: (id: string) => Effect.Effect<void, RunnerNotFound | RunnerPlatformError>
  }
>()("@akter/deployments/runners/contract/RunnerPlatform") {}

/**
 * The provider-safe name of a start: 64 lowercase hex characters, which any
 * provider accepts as a token or truncates to a shorter name, the same for
 * the same deployment and key, and different for any other pair. A deployment
 * id never contains a NUL, so the separator keeps the pair unambiguous.
 */
export const startToken = (input: Pick<StartInput, "deploymentId" | "idempotencyKey">) =>
  hashHex(`${input.deploymentId}\0${input.idempotencyKey}`)

/** The SHA-256 of `text` as 64 lowercase hex characters. */
export const hashHex = (text: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const bytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(text))

    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }).pipe(Effect.mapError(() => platformError({ operation: "start", code: "unavailable" })))

/** Decodes a start request, failing as the platform would for a request it cannot honor. */
export const decodeStart = (input: StartInput) =>
  Schema.decodeEffect(StartInput)(input).pipe(
    Effect.mapError(() => platformError({ operation: "start", code: "invalid-input" })),
  )
