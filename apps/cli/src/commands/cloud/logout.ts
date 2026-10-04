import { Console, Effect, Option } from "effect"
import { Command } from "effect/cli"
import { HttpClient, HttpClientRequest } from "effect/http"
import { reportFailures } from "./client.ts"
import { loadCredentials, removeCredentials } from "./credentials.ts"

/**
 * Revokes the stored session at its control plane, then deletes the stored
 * credentials whatever the control plane answered, so a logout never leaves a
 * usable token on disk. Credentials the CLI refuses to read are deleted
 * without a revocation.
 */
export const logout = Effect.gen(function* () {
  const credentials = yield* loadCredentials.pipe(
    Effect.asSome,
    Effect.catchTags({
      CredentialsExposed: () => Effect.succeedNone,
      CredentialsUnreadable: () => Effect.succeedNone,
    }),
    Effect.map(Option.getOrUndefined),
  )
  const revoked =
    credentials === undefined
      ? false
      : yield* HttpClient.HttpClient.pipe(
          Effect.flatMap((client) =>
            client.execute(
              HttpClientRequest.post(`${credentials.apiUrl}/auth/sign-out`).pipe(
                HttpClientRequest.bearerToken(credentials.token),
                HttpClientRequest.bodyJsonUnsafe({}),
              ),
            ),
          ),
          Effect.map((response) => response.status === 200),
          Effect.orElseSucceed(() => false),
        )

  yield* removeCredentials

  return { credentials, revoked }
})

/** `durable logout`: signs out of the control plane and deletes the stored credentials. */
export const logoutCommand = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    const { credentials, revoked } = yield* logout

    if (credentials === undefined) return yield* Console.log("Removed the stored credentials.")

    yield* Console.log(
      revoked
        ? `Logged out of ${credentials.apiUrl}.`
        : `Removed the stored credentials. ${credentials.apiUrl} could not revoke the session, which ends when it expires.`,
    )
  }).pipe(
    Effect.catchTag("NotLoggedIn", () => Console.log("Not logged in.")),
    reportFailures,
  ),
).pipe(Command.withDescription("Sign out of Akter Cloud and delete the stored session"))
