import * as Cloud from "@akter/cloud-api"
import { type Config, Console, Duration, Effect, Match, type PlatformError, Schema } from "effect"
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { CommandFailed, fail } from "../../failure.ts"
import {
  type Credentials,
  type CredentialsExposed,
  type CredentialsUnreadable,
  loadCredentials,
  type NotLoggedIn,
} from "./credentials.ts"

/** The control plane `login` signs in to when neither `--api-url` nor `AKTER_API_URL` names one. */
export const DEFAULT_API_URL = "https://api.akter.dev"

/** The `CloudApi` client for the control plane `credentials` name, sending their session token as a bearer token. */
export const cloudClient = (credentials: Credentials) =>
  HttpApiClient.make(Cloud.CloudApi, {
    baseUrl: credentials.apiUrl,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(credentials.token)),
  })

/** The stored credentials and a client signed in with them. */
export const signedIn = Effect.gen(function* () {
  const credentials = yield* loadCredentials

  return { credentials, client: yield* cloudClient(credentials) }
})

/** How many failed control-plane reads in a row a follower retries before it gives up. */
export const MAX_READ_RETRIES = 5

/** The wait before a follower's `attempt`th retry in a row: 1, 2 and 4 seconds, then 8. */
export const readRetryDelay = (attempt: number) => Duration.seconds(Math.min(2 ** (attempt - 1), 8))

/**
 * Whether a failed read may succeed when repeated: an `Unavailable` outage
 * (not one naming a known condition such as `unknownPlan`), a request that got
 * no answer, or a 5xx answer the client could not read as a declared error,
 * such as a proxy's 502 page. Refusals and unreadable answers with any other
 * status fail the same way again.
 */
export const isTransient = (error: HostedFailure) =>
  Match.value(error).pipe(
    Match.tag("Unavailable", (unavailable) => unavailable.reason === undefined),
    Match.tag("HttpClientError", ({ reason }) =>
      Match.value(reason).pipe(
        Match.tag("TransportError", () => true),
        Match.tag(
          "StatusCodeError",
          "DecodeError",
          "EmptyBodyError",
          ({ response }) => response.status >= 500,
        ),
        Match.orElse(() => false),
      ),
    ),
    Match.orElse(() => false),
  )

/**
 * Retries the reads made through it after transient failures, printing
 * `notice` and waiting `readRetryDelay` before each retry. One count spans
 * every read made through it and resets after any success, so a follower
 * gives up after `MAX_READ_RETRIES` failures in a row rather than per read.
 */
export const retryTransient = (notice: string) => {
  let failures = 0
  const read = <A, E extends HostedFailure, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          failures = 0
        }),
      ),
      Effect.catchIf(
        (error) => failures < MAX_READ_RETRIES && isTransient(error),
        () =>
          Effect.gen(function* () {
            failures += 1
            yield* Console.error(notice)
            yield* Effect.sleep(readRetryDelay(failures))
            return yield* read(effect)
          }),
      ),
    )

  return read
}

/** Every failure the hosted commands share. */
export type HostedFailure =
  | NotLoggedIn
  | CredentialsExposed
  | CredentialsUnreadable
  | Cloud.Unauthorized
  | Cloud.Forbidden
  | Cloud.NotFound
  | Cloud.Conflict
  | Cloud.NotImplemented
  | Cloud.PayloadTooLarge
  | Cloud.Unavailable
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | PlatformError.PlatformError
  | Config.ConfigError

const octal = (mode: number) => mode.toString(8).padStart(3, "0")

/**
 * How a shared failure ends a hosted command. Missing, exposed or unreadable
 * credentials and an unreachable control plane are usage errors (exit 2); a
 * session the control plane no longer accepts and a refusal it answered are
 * refusals (exit 1).
 */
const describe = Match.type<HostedFailure>().pipe(
  Match.tagsExhaustive({
    NotLoggedIn: () => ({
      reason: "NotLoggedIn",
      message: "Not logged in. Run `akter login` first.",
      exitCode: 2,
    }),
    CredentialsExposed: (error) => ({
      reason: "CredentialsExposed",
      message: `${error.path} can be read by other users (mode ${octal(error.mode)}). Run \`chmod 600\` on it or \`akter login\` again.`,
      exitCode: 2,
    }),
    CredentialsUnreadable: (error) => ({
      reason: "CredentialsUnreadable",
      message: `${error.path} does not hold akter credentials. Run \`akter login\` again.`,
      exitCode: 2,
    }),
    Unauthorized: () => ({
      reason: "Unauthorized",
      message: "Your session has expired or was revoked. Run `akter login` to sign in again.",
      exitCode: 1,
    }),
    Forbidden: (error) => ({
      reason: "Forbidden",
      message: `Refused: ${error.message}`,
      exitCode: 1,
    }),
    NotFound: (error) => ({
      reason: "NotFound",
      message: `No ${error.resource} ${error.id} is visible to you.`,
      exitCode: 1,
    }),
    Conflict: (error) => ({
      reason: "Conflict",
      message: `Refused: ${error.message}`,
      exitCode: 1,
    }),
    NotImplemented: (error) => ({
      reason: "NotImplemented",
      message: `This control plane does not support ${error.operation}.`,
      exitCode: 1,
    }),
    PayloadTooLarge: (error) => ({
      reason: "PayloadTooLarge",
      message: `The control plane accepts at most ${error.limitBytes} bytes; exclude more files in .dockerignore.`,
      exitCode: 1,
    }),
    Unavailable: () => ({
      reason: "Unavailable",
      message: "The control plane is temporarily unavailable. Try again shortly.",
      exitCode: 1,
    }),
    HttpClientError: (error) => ({
      reason: "Unreachable",
      message: `Cannot reach the control plane: ${error.message}`,
      exitCode: 2,
    }),
    SchemaError: (error) => ({
      reason: "SchemaError",
      message: `The control plane's answer was not understood: ${error.message}`,
      exitCode: 2,
    }),
    PlatformError: (error) => ({
      reason: "PlatformError",
      message: `Cannot use the file system: ${error.message}`,
      exitCode: 2,
    }),
    ConfigError: (error) => ({
      reason: "ConfigError",
      message: `Cannot read the environment: ${error.message}`,
      exitCode: 2,
    }),
  }),
)

/**
 * Ends a hosted command on a shared failure with its message and exit
 * status. A `CommandFailed` has already printed why and passes through.
 */
export const reportFailures = <A, R>(effect: Effect.Effect<A, HostedFailure | CommandFailed, R>) =>
  Effect.catchIf(
    effect,
    (error): error is HostedFailure => !Schema.is(CommandFailed)(error),
    (error) => fail(describe(error)),
  )
