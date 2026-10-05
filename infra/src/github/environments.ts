import * as Axiom from "alchemy/Axiom"
import * as GitHub from "alchemy/GitHub"
import * as Namespace from "alchemy/Namespace"
import { Config, Effect, Option } from "effect"
import { datasets } from "../telemetry.ts"

export const repository = { owner: "Rika-Labs", repository: "akter" }

const everything = ["create", "read", "update", "delete"]

const variables = (entries: ReadonlyArray<readonly [string, Option.Option<string>]>) =>
  Object.fromEntries(
    entries.flatMap(([name, value]) =>
      Option.match(value, { onNone: () => [], onSome: (text) => [[name, text] as const] }),
    ),
  )

/**
 * The credentials `.github/workflows/deploy.yml` reads, written into the `preview` and
 * `production` environments of the repository from the values in this stack's own environment.
 * `preview` serves every pull request preview and the `preview` stage; `production` serves `prod`
 * and is open to deployments from `main` alone, with no reviewer to wait for. Pull request code
 * runs with the `preview` secrets, so everything that could reach production is read per
 * environment as `PREVIEW_<NAME>` and `PRODUCTION_<NAME>`: the Fly and Stripe credentials, the
 * state database, the PlanetScale token, the Resend key and the Neki sizes. Give `preview` values
 * that cannot touch production, above all a state database of its own, because state holds
 * `prod`'s generated secrets. Only the Vercel token is shared, and it can edit every DNS record in
 * the team. The Axiom token each environment receives is minted here with only what that
 * environment's deploys need, including ingest on the shared datasets so it can mint each stage's
 * ingest token (Axiom refuses to grant a capability its creator lacks), and is not a copy of the
 * token running this stack. Anything the
 * stack does not mint is copied.
 */
export const environments = Effect.gen(function* () {
  const shared = {
    secrets: {
      VERCEL_TOKEN: yield* Config.Redacted("VERCEL_TOKEN"),
    },
    variables: variables([
      ["PLANETSCALE_ORGANIZATION", Option.some(yield* Config.String("PLANETSCALE_ORGANIZATION"))],
      ["VERCEL_TEAM_ID", yield* Config.String("VERCEL_TEAM_ID").pipe(Config.option)],
      ["AXIOM_ORG_ID", yield* Config.String("AXIOM_ORG_ID").pipe(Config.option)],
    ]),
  }

  const environment = Effect.fn(function* (input: {
    name: "preview" | "production"
    prefix: "PREVIEW" | "PRODUCTION"
    branches: ReadonlyArray<string> | undefined
    axiom: Axiom.ApiTokenProps["orgCapabilities"]
    production: boolean
  }) {
    const github = yield* GitHub.Environment(input.name, {
      ...repository,
      name: input.name,
      deploymentBranchPolicy:
        input.branches === undefined ? undefined : { customBranchPolicies: [...input.branches] },
    })
    const axiom = yield* Axiom.ApiToken("AxiomToken", {
      name: `akter-ci-${input.name}`,
      description: `Alchemy deploys of the ${input.name} environment`,
      orgCapabilities: input.axiom,
      datasetCapabilities: {
        [datasets.traces]: { ingest: ["create"] },
        [datasets.logs]: { ingest: ["create"] },
      },
    })
    yield* GitHub.Secrets({
      ...repository,
      environment: github,
      secrets: {
        ...shared.secrets,
        ALCHEMY_STATE_DATABASE_URL: yield* Config.Redacted(
          `${input.prefix}_ALCHEMY_STATE_DATABASE_URL`,
        ),
        PLANETSCALE_API_TOKEN_ID: yield* Config.Redacted(
          `${input.prefix}_PLANETSCALE_API_TOKEN_ID`,
        ),
        PLANETSCALE_API_TOKEN: yield* Config.Redacted(`${input.prefix}_PLANETSCALE_API_TOKEN`),
        RESEND_API_KEY: yield* Config.Redacted(`${input.prefix}_RESEND_API_KEY`),
        FLY_API_TOKEN: yield* Config.Redacted(`${input.prefix}_FLY_API_TOKEN`),
        STRIPE_API_KEY: yield* Config.Redacted(`${input.prefix}_STRIPE_API_KEY`),
        AXIOM_TOKEN: axiom.token,
      },
    })
    yield* GitHub.Variables({
      ...repository,
      environment: github,
      variables: {
        ...shared.variables,
        ...variables([
          [
            "NEKI_CLUSTER_SIZE",
            Option.some(yield* Config.String(`${input.prefix}_NEKI_CLUSTER_SIZE`)),
          ],
          [
            "NEKI_ROUTER_SIZE",
            Option.some(yield* Config.String(`${input.prefix}_NEKI_ROUTER_SIZE`)),
          ],
          [
            "NEKI_SHARD_COUNT",
            input.production
              ? yield* Config.String(`${input.prefix}_NEKI_SHARD_COUNT`).pipe(Config.option)
              : Option.none(),
          ],
          [
            "STRIPE_MODE",
            input.production
              ? Option.some(yield* Config.String("PRODUCTION_STRIPE_MODE"))
              : Option.none(),
          ],
          [
            "AXIOM_NOTIFIER_ID",
            input.production
              ? Option.some(yield* Config.String("AXIOM_NOTIFIER_ID"))
              : Option.none(),
          ],
        ]),
      },
    })
    return github.name
  })

  const preview = yield* environment({
    name: "preview",
    prefix: "PREVIEW",
    branches: undefined,
    axiom: {
      datasets: everything,
      apiTokens: ["create", "read", "delete"],
    },
    production: false,
  }).pipe(Namespace.push("preview"))
  const production = yield* environment({
    name: "production",
    prefix: "PRODUCTION",
    branches: ["main"],
    axiom: {
      datasets: everything,
      monitors: everything,
      notifiers: ["read"],
      apiTokens: ["create", "read", "delete"],
    },
    production: true,
  }).pipe(Namespace.push("production"))

  return { preview, production }
})
