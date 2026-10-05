import { Config, Effect, Option, Redacted, Schema } from "effect"
import { Stage } from "alchemy/Stage"

/** The Fly organization that holds every pull request preview, and the one that holds `prod`. */
export const flyOrganizations = { preview: "rika-labs-dev", production: "rika-labs-prod" }

/** The Vercel-hosted domain that carries the platform hostnames. */
export const platformZone = "akter.dev"

/** The Vercel-hosted domain that carries customer deployments; only records are created in it. */
export const customerZone = "akter.run"

/**
 * The hostname of the public documentation, which Mintlify serves from the repository's `docs/`
 * directory, and the Mintlify hostname its record points at.
 */
export const docs = { host: `docs.${platformZone}`, target: "cname.mintlify.builders" } as const

/** The Fly region every machine runs in. */
export const region = "iad"

/** The Akter region id the runner configuration keys the Fly region by. */
export const akterRegion = "us-east-1"

export const repositoryRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "")

/**
 * The stage that owns what every pull request preview shares. It runs no application: it is the
 * database cluster the previews' logical databases live on, and the Axiom datasets they ingest into.
 */
export const sharedStage = "preview"

/** The free hostname Fly gives every app. */
export const flyHostname = (app: string) => `${app}.fly.dev`

const pullRequestStage = /^pr-([1-9][0-9]{0,5})$/

export interface SharedLayout {
  readonly kind: "shared"
  readonly stage: typeof sharedStage
}

/** The layout of a stage that runs the four services. */
export interface Layout {
  readonly stage: string
  readonly kind: "prod" | "pr"
  /** The pull request number of a `pr-<n>` stage. */
  readonly pullRequest: number | undefined
  readonly flyOrganization: string
  readonly region: string
  /** Idle previews stop their machines and wake on the next request. */
  readonly sleeps: boolean
  /**
   * Whether the four platform hosts are custom domains on the platform zone, each with a Fly
   * certificate and a DNS record. A preview uses the free `<app>.fly.dev` hostnames instead:
   * every certificate it issued on the platform zone counted against the zone's weekly Let's
   * Encrypt limit, which `prod` shares. `fly.dev` is a public suffix, so a preview's console and
   * API are different sites and its API must issue cross-site cookies.
   */
  readonly customDomains: boolean
  readonly hosts: {
    readonly site: string
    readonly console: string
    readonly api: string
    readonly edge: string
  }
  /** `DEPLOYMENT_DOMAIN`: the one place a stage's customer domain is written. */
  readonly customerDomain: string
  /** The sender of the API's email; every stage sends from the root domain, which Resend verified. */
  readonly emailFrom: string
  /** Fly app names, which are global across Fly, so each carries the stage. */
  readonly apps: {
    readonly api: string
    readonly edge: string
    readonly console: string
    readonly site: string
  }
  readonly runnerPrefix: string
  /** Only `prod` may bill in Stripe live mode; a preview always bills in test mode. */
  readonly liveBilling: boolean
  readonly edgeMachines: number
}

export type StageLayout = SharedLayout | Layout

/**
 * The only stages are `prod`, `preview` and `pr-<n>`; anything else, including a leftover
 * `dev` or `staging`, is refused before a provider is reached.
 */
export const layoutOf = (stage: string): StageLayout => {
  if (stage === sharedStage) return { kind: "shared", stage }
  const number = pullRequestStage.exec(stage)?.[1]
  if (stage !== "prod" && number === undefined)
    throw new Error(`Unsupported stage "${stage}": use prod, ${sharedStage} or pr-<number>`)
  const production = stage === "prod"
  const apps = {
    api: `akter-${stage}-api`,
    edge: `akter-${stage}-edge`,
    console: `akter-${stage}-console`,
    site: `akter-${stage}-site`,
  }
  return {
    stage,
    kind: production ? "prod" : "pr",
    pullRequest: number === undefined ? undefined : Number(number),
    flyOrganization: production ? flyOrganizations.production : flyOrganizations.preview,
    region,
    sleeps: !production,
    customDomains: production,
    hosts: production
      ? {
          site: platformZone,
          console: `app.${platformZone}`,
          api: `api.${platformZone}`,
          edge: `edge.${platformZone}`,
        }
      : {
          site: flyHostname(apps.site),
          console: flyHostname(apps.console),
          api: flyHostname(apps.api),
          edge: flyHostname(apps.edge),
        },
    customerDomain: production ? customerZone : `${stage}.preview.${customerZone}`,
    emailFrom: production
      ? `Akter <auth@${platformZone}>`
      : `Akter Preview <auth-preview@${platformZone}>`,
    apps,
    runnerPrefix: `akter-${stage.replace("-", "")}-run-`,
    liveBilling: production,
    edgeMachines: production ? 2 : 1,
  }
}

/**
 * Refuses an operation that must never reach the stage from where it was started: CI destroys
 * only pull request previews, never `prod` and never the `preview` stage they all depend on.
 */
export const assertOperation = (input: {
  readonly operation: "deploy" | "destroy"
  readonly stage: string
  readonly ci: boolean
}) => {
  const layout = layoutOf(input.stage)
  if (input.operation === "destroy" && input.ci && layout.kind !== "pr")
    throw new Error(`Stage ${layout.stage} is never destroyed from CI`)
  return layout
}

export const StripeMode = Schema.Literals(["test", "live"])
export type StripeMode = typeof StripeMode.Type

/**
 * A Stripe secret or restricted key must belong to the mode the stage bills in. `prod` bills in
 * whichever mode its environment names, so test mode before launch is an explicit, recorded choice
 * rather than a missing key; a preview may never bill in live mode.
 */
export const assertStripeMode = (input: {
  readonly layout: Layout
  readonly mode: StripeMode
  readonly key: Redacted.Redacted<string>
}) => {
  const { layout, mode, key } = input
  if (mode === "live" && !layout.liveBilling)
    throw new Error(`Stage ${layout.stage} never bills in Stripe live mode`)
  if (!new RegExp(`^(sk|rk)_${mode}_`).test(Redacted.value(key)))
    throw new Error(`Stage ${layout.stage} bills in Stripe ${mode} mode`)
}

/** The runtime configuration of the api's `RUNNER_FLY_CONFIG`. */
export const runnerFlyConfig = (layout: Layout) =>
  JSON.stringify({
    organization: layout.flyOrganization,
    regions: { [akterRegion]: { region: layout.region } },
    port: 8080,
    appPrefix: layout.runnerPrefix,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 512 },
  })

/** The stage being deployed, as its layout. */
export const stageLayout = Effect.gen(function* () {
  const stage = yield* Stage
  return yield* Effect.try(() => layoutOf(stage))
}).pipe(Effect.orDie)

export const planetscaleOrganization = Config.String("PLANETSCALE_ORGANIZATION")

/** What a stage that runs the four services reads from its environment. */
export const deployment = (layout: Layout) =>
  Effect.gen(function* () {
    const stripeKey = yield* Config.Redacted("STRIPE_API_KEY")
    const stripeMode: StripeMode = layout.liveBilling
      ? yield* Config.schema(StripeMode, "STRIPE_MODE")
      : "test"
    yield* Effect.try(() => assertStripeMode({ layout, mode: stripeMode, key: stripeKey }))
    return {
      layout,
      flyToken: yield* Config.Redacted("FLY_API_TOKEN"),
      resendApiKey: yield* Config.Redacted("RESEND_API_KEY"),
      stripeKey,
      imageTag: yield* Config.String("IMAGE_TAG").pipe(
        Config.orElse(() => Config.String("GITHUB_SHA")),
        Config.withDefault("local"),
      ),
      planetscaleOrganization: yield* planetscaleOrganization,
      vercelTeamId: Option.getOrUndefined(
        yield* Config.String("VERCEL_TEAM_ID").pipe(Config.option),
      ),
    }
  }).pipe(Effect.orDie)

export type Deployment = Effect.Success<ReturnType<typeof deployment>>

/** The stack's Alchemy name; a pull request preview reads the `preview` stage's output through it. */
export const stackName = "akter"

/** What a pull request preview needs from the `preview` stage's output. */
/**
 * The Neki cluster every pull request preview shares, owned by the `preview` stage. A preview names
 * it directly rather than reading the `preview` stage's state: Alchemy's Postgres state holds a
 * stage's lock for the whole run of anything that reads it, so reading it would serialize every
 * preview deploy and destroy behind one another and behind a deploy of `preview` itself.
 */
export const sharedNekiCluster = { database: `akter-${sharedStage}`, branch: "main" } as const

/** The record name of `host` inside `zone`: empty for the apex. */
export const relativeName = (input: { readonly zone: string; readonly host: string }) => {
  const { zone, host } = input
  if (host === zone) return ""
  if (!host.endsWith(`.${zone}`)) throw new Error(`${host} is not inside ${zone}`)
  return host.slice(0, -(zone.length + 1))
}
