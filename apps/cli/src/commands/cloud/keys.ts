import { EnvironmentApiKeyTenant, EnvironmentName, Name, ProjectId } from "@akter/cloud-api"
import { Config, Console, DateTime, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { reportFailures, signedIn } from "./client.ts"

const scope = {
  project: Flag.String("project").pipe(
    Flag.withFallbackConfig(Config.String("AKTER_PROJECT")),
    Flag.withSchema(ProjectId),
    Flag.withDescription("The project (default AKTER_PROJECT)"),
  ),
  environment: Flag.Literals("env", EnvironmentName.literals).pipe(
    Flag.withDefault("production"),
    Flag.withDescription("The environment (default production)"),
  ),
}

const create = Command.make(
  "create",
  {
    ...scope,
    name: Argument.String("name").pipe(
      Argument.withSchema(Name),
      Argument.withDescription("The key's display name"),
    ),
    tenant: Flag.String("tenant").pipe(
      Flag.withSchema(EnvironmentApiKeyTenant),
      Flag.optional,
      Flag.withDescription("The application's tenant (default default)"),
    ),
  },
  ({ project, environment, name, tenant }) =>
    Effect.gen(function* () {
      const { client } = yield* signedIn
      const created = yield* client.environmentApiKeys.create({
        params: { projectId: project, environment },
        payload: Option.isSome(tenant) ? { name, tenant: tenant.value } : { name },
      })
      yield* Console.error(
        `Created ${created.key.id} in ${environment} for tenant ${created.key.tenant}. Save the secret printed on stdout now; it cannot be read again.`,
      )
      yield* Console.log(created.secret)
    }).pipe(reportFailures),
).pipe(Command.withDescription("Create an environment key; print its one-time secret on stdout"))

const list = Command.make("list", scope, ({ project, environment }) =>
  Effect.gen(function* () {
    const { client } = yield* signedIn
    const keys = yield* client.environmentApiKeys.list({
      params: { projectId: project, environment },
    })
    for (const key of keys)
      yield* Console.log(
        `${key.id}\t${key.name}\t${key.tenant}\t${DateTime.formatIso(key.createdAt)}\t${key.revokedAt === null ? "active" : DateTime.formatIso(key.revokedAt)}`,
      )
  }).pipe(reportFailures),
).pipe(Command.withDescription("List key metadata, including revoked keys; never print secrets"))

const revoke = Command.make(
  "revoke",
  {
    ...scope,
    keyId: Argument.String("keyId").pipe(Argument.withDescription("The key id to revoke")),
  },
  ({ project, environment, keyId }) =>
    Effect.gen(function* () {
      const { client } = yield* signedIn
      yield* client.environmentApiKeys.revoke({
        params: { projectId: project, environment, keyId },
      })
      yield* Console.log(`Revoked ${keyId} in ${environment}.`)
    }).pipe(reportFailures),
).pipe(Command.withDescription("Revoke an environment key"))

export const keysCommand = Command.make("keys").pipe(
  Command.withDescription("Manage Akter Cloud environment API keys for deployed applications"),
  Command.withSubcommands([create, list, revoke]),
)
