import * as Schema from "effect/Schema"

const Identifier = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/u))

export const Deployment = Schema.Struct({
  project: Identifier,
  stage: Schema.Literals(["dev", "pr", "staging", "prod"]),
  owner: Identifier,
  id: Identifier,
  expiresAt: Schema.optionalKey(Schema.String),
  appOrigin: Schema.optionalKey(Schema.String),
})

export type Deployment = typeof Deployment.Type

export const DeploymentJson = Schema.fromJsonString(Deployment)

export function deployment({
  input,
  now,
  destroying = false,
}: {
  input: Deployment
  now: number
  destroying?: boolean
}) {
  const ephemeral = input.stage === "dev" || input.stage === "pr"
  const expires = Date.parse(input.expiresAt ?? "")

  if (
    ephemeral &&
    (!Number.isFinite(expires) || (!destroying && (expires <= now || expires > now + 7 * 86400000)))
  ) {
    throw new Error("Ephemeral deployments require a future TTL of at most seven days")
  }

  if (!ephemeral && input.expiresAt !== undefined)
    throw new Error("Persistent environments cannot expire")

  return {
    ...input,
    key: `${input.project}-${input.stage}-${input.owner}-${input.id}`,
    ephemeral,
    migrationOwner: "alchemy:Planetscale.PostgresDatabase",
    source: "working-tree",
  }
}

export function assertDestroy({
  input,
  actor,
  now,
}: {
  input: Deployment
  actor: string
  now: number
}) {
  if (input.stage === "prod" || input.stage === "staging")
    throw new Error("Persistent environment deletion is protected")

  if (input.owner !== actor) throw new Error("Deployment belongs to another owner")

  if (input.expiresAt === undefined || !Number.isFinite(Date.parse(input.expiresAt)))
    throw new Error("Missing TTL")

  return { expired: Date.parse(input.expiresAt) <= now }
}
