import { Effect, Redacted } from "effect"
import type { ActorError } from "../../contract/errors.ts"
import { type AuthRequest, bearerToken, unauthorized } from "../../serve/auth.ts"
import type { OperatorGrant } from "./grants.ts"

/**
 * Authenticates an operator request to a grant. It is a different type from
 * `Auth`'s providers, which return an application caller, so no
 * application credential can reach an operator route.
 */
export interface OperatorAuth<R = never> {
  readonly authenticate: (request: AuthRequest) => Effect.Effect<OperatorGrant, ActorError, R>
}

/** An operator provider from a function, e.g. one that verifies an identity provider's token. */
const make = <R = never>(authenticate: OperatorAuth<R>["authenticate"]): OperatorAuth<R> => ({
  authenticate,
})

const digest = (text: string) =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((bytes) => new Uint8Array(bytes))

/**
 * Compares digests without an early exit, and every configured digest is
 * compared in full, so timing reveals neither which entry matched nor how much
 * of a digest did.
 */
const equalDigests = (a: Uint8Array, b: Uint8Array) => {
  let difference = a.length ^ b.length

  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ (b[index] ?? 0)

  return difference === 0
}

/**
 * Bearer tokens configured with the deployment, each with its grant. Only
 * SHA-256 digests of the tokens are kept after construction.
 */
const tokens = (
  entries: ReadonlyArray<{
    readonly token: Redacted.Redacted<string>
    readonly grant: OperatorGrant
  }>,
): OperatorAuth => {
  const digests = Promise.all(
    entries.map(({ token, grant }) =>
      digest(Redacted.value(token)).then((configured) => ({ digest: configured, grant })),
    ),
  )

  return make((request: AuthRequest) =>
    Effect.flatMap(bearerToken(request), (token) =>
      Effect.flatMap(
        Effect.promise(() => Promise.all([digests, digest(token)])),
        ([configured, presented]) => {
          let found: OperatorGrant | undefined

          for (const entry of configured)
            if (equalDigests(entry.digest, presented)) found = entry.grant

          return found === undefined
            ? Effect.fail(unauthorized("invalid_credentials"))
            : Effect.succeed(found)
        },
      ),
    ),
  )
}

/** Constructors for operator providers: `make` from a function, `tokens` from configured bearer tokens. */
export const OperatorAuth = { make, tokens }
