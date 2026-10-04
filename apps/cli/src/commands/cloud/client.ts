import * as Cloud from "@akter/cloud-api"
import { type Config, Effect, Match, type PlatformError, Schema } from "effect"
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

/** The control plane `login` signs in to when neither `--api-url` nor `AKTER_API_URL` names one: the local stack. */
export const DEFAULT_API_URL = "http://localhost:3001"

/** A base URL without its trailing slashes. */
export const trimUrl = (url: string) => url.replace(/\/+$/u, "")

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
      message: "Not logged in. Run `durable login` first.",
      exitCode: 2,
    }),
    CredentialsExposed: (error) => ({
      reason: "CredentialsExposed",
      message: `${error.path} can be read by other users (mode ${octal(error.mode)}). Run \`chmod 600\` on it or \`durable login\` again.`,
      exitCode: 2,
    }),
    CredentialsUnreadable: (error) => ({
      reason: "CredentialsUnreadable",
      message: `${error.path} does not hold durable credentials. Run \`durable login\` again.`,
      exitCode: 2,
    }),
    Unauthorized: () => ({
      reason: "Unauthorized",
      message: "Your session has expired or was revoked. Run `durable login` to sign in again.",
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
