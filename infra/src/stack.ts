import * as GitHub from "alchemy/GitHub"
import { KeyPair } from "alchemy/KeyPair"
import * as Output from "alchemy/Output"
import { makeRandom } from "alchemy/Random"
import * as Stripe from "alchemy/Stripe"
import { Effect } from "effect"
import { applications } from "./applications.ts"
import { deployment as configuration, planetscaleOrganization, stageLayout } from "./config.ts"
import { controlPlane, sharedDatabase } from "./database.ts"
import { signingKeys } from "./signing-keys.ts"
import { sharedDatasets, telemetry } from "./telemetry.ts"

/** The Stripe events the billing synchronization reads. */
const billingEvents = [
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
  "invoice.created",
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.updated",
  "invoice.voided",
  "invoice.marked_uncollectible",
]

/**
 * A stage is one of two things. `prod` and every `pr-<n>` run the four services against their
 * own database and billing. `preview` runs nothing: it owns the Neki cluster and the telemetry
 * datasets that the pull request previews share, and publishes where the cluster is.
 */
export const resources = Effect.gen(function* () {
  const stage = yield* stageLayout
  if (stage.kind === "shared") {
    yield* sharedDatasets
    return yield* sharedDatabase({
      layout: stage,
      planetscaleOrganization: yield* planetscaleOrganization.pipe(Effect.orDie),
    })
  }
  const deployment = yield* configuration(stage)
  const { layout } = deployment
  const database = yield* controlPlane(deployment)
  const ingest = yield* telemetry(deployment)
  const authSecret = yield* makeRandom("AuthSecret", { bytes: 48 })
  const signing = yield* KeyPair("EdgeSigningKey", { algorithm: "ed25519" })
  const webhook = yield* Stripe.WebhookEndpoint("Billing", {
    url: `https://${layout.hosts.api}/api/billing/webhook`,
    enabledEvents: billingEvents,
    description: `Akter ${layout.stage}`,
  })

  yield* applications({
    deployment,
    databaseUrl: database.url,
    authSecret,
    edgeSigningKeys: signing.privateKey.pipe(Output.mapEffect(signingKeys)),
    stripeWebhookSecret: webhook.secret.pipe(
      Output.map((secret) => {
        if (secret === undefined)
          throw new Error("Stripe returned no signing secret for the billing webhook")
        return secret
      }),
    ),
    telemetry: ingest,
  })

  const github = yield* GitHub.GitHubEnv
  if (github?.pr !== undefined && layout.pullRequest !== undefined) {
    if (github.pr !== layout.pullRequest)
      return yield* Effect.die(
        new Error(`Stage ${layout.stage} cannot comment on pull request ${github.pr}`),
      )
    yield* GitHub.Comment("PreviewUrls", {
      owner: github.owner,
      repository: github.repository,
      issueNumber: layout.pullRequest,
      body: [
        "## Preview",
        "",
        "| Service | URL |",
        "| --- | --- |",
        `| Site | https://${layout.hosts.site} |`,
        `| Console | https://${layout.hosts.console} |`,
        `| API | https://${layout.hosts.api} |`,
        `| Edge | https://${layout.hosts.edge} |`,
        `| Customer deployments | \`*.${layout.customerDomain}\` |`,
        "",
        `Commit \`${github.sha.slice(0, 7)}\`. Idle machines stop and start again on the next request, so the first one after a pause is slow. The console and API are different sites on \`fly.dev\`, so sign-in uses partitioned cross-site cookies: use Chrome or Firefox, as Safari may block them.`,
      ].join("\n"),
    })
  }

  return {
    stage: layout.stage,
    flyOrganization: layout.flyOrganization,
    region: layout.region,
    urls: {
      site: `https://${layout.hosts.site}`,
      console: `https://${layout.hosts.console}`,
      api: `https://${layout.hosts.api}`,
      edge: `https://${layout.hosts.edge}`,
    },
    customerDomain: layout.customerDomain,
    neki: database.neki,
  }
})
