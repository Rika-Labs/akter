import { listSecretsV4 } from "@distilled.cloud/infisical"
import { CredentialsFromEnv } from "@distilled.cloud/infisical/Credentials"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

export const secretsLayer = Layer.mergeAll(CredentialsFromEnv, FetchHttpClient.layer)

/** Caller owns the runtime/layer lifetime. Values never cross the boundary as plain strings. */
export const loadSecrets = Effect.fn("loadSecrets")(function* (
  projectId: string,
  environment: string,
  secretPath: string,
) {
  const result = yield* listSecretsV4({
    projectId,
    environment,
    secretPath,
    viewSecretValue: true,
    recursive: false,
    includeImports: false,
    includePersonalOverrides: false,
  })

  const entries: [string, Redacted.Redacted<string>][] = []

  for (const secret of result.secrets) {
    if (secret.secretValueHidden)
      return yield* Effect.die(new Error("Infisical denied secret value access"))
    entries.push([
      Redacted.isRedacted(secret.secretKey) ? Redacted.value(secret.secretKey) : secret.secretKey,
      Redacted.make(secret.secretValue),
    ])
  }

  return Object.fromEntries(entries)
})
