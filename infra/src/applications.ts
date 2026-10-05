import * as Docker from "alchemy/Docker"
import * as Fly from "alchemy/Fly"
import type { Input } from "alchemy/Input"
import * as Namespace from "alchemy/Namespace"
import * as Output from "alchemy/Output"
import { Effect, Redacted } from "effect"
import {
  customerZone,
  flyHostname,
  platformZone,
  relativeName,
  repositoryRoot,
  runnerFlyConfig,
  type Deployment,
  type Layout,
} from "./config.ts"
import { Vercel } from "./vercel/resources.ts"

type Secrets = Readonly<Record<string, Input<Redacted.Redacted<string>>>>

/**
 * The proxy service of a public machine. A preview stops when idle and starts on the next request,
 * so an open pull request costs nothing while nobody uses it; `prod` stays running.
 */
const publicService = (
  layout: Layout,
  input: { port: number; check: { type: "http" | "tcp"; path?: string }; count: number },
) => [
  {
    protocol: "tcp",
    internalPort: input.port,
    autostart: true,
    autostop: layout.sleeps ? ("stop" as const) : ("off" as const),
    minMachinesRunning: layout.sleeps ? 0 : input.count,
    ports: [
      { port: 80, handlers: ["http"], forceHttps: true },
      { port: 443, handlers: ["tls", "http"] },
    ],
    checks: [
      {
        type: input.check.type,
        port: input.port,
        path: input.check.path,
        method: input.check.type === "http" ? "GET" : undefined,
        interval: "15s",
        timeout: "5s",
        gracePeriod: "30s",
      },
    ],
  },
]

const cname = (deployment: Deployment, id: string, host: string, target: string) =>
  Vercel.DnsRecord(id, {
    domain: platformZone,
    teamId: deployment.vercelTeamId,
    name: relativeName({ zone: platformZone, host }),
    type: "CNAME",
    value: flyHostname(target),
  })

/**
 * One service built from a Dockerfile in this repository: its Fly app, addresses, image,
 * secrets, machines and, on a stage with custom domains, certificate and DNS record. The machines carry each secret's digest as
 * metadata, so rotating a secret restarts them with the new value.
 */
const dockerService = (
  deployment: Deployment,
  input: {
    role: "api" | "edge"
    app: Fly.App
    host: string
    dockerfile: string
    port: number
    check: { type: "http" | "tcp"; path?: string }
    memoryMb: number
    count: number
    command?: string[]
    env: Readonly<Record<string, string>>
    secrets: Secrets
  },
) =>
  Effect.gen(function* () {
    const { layout, flyToken } = deployment
    const { app } = input
    yield* Fly.IpAssignment("SharedV4", { app, type: "shared_v4" })
    yield* Fly.IpAssignment("V6", { app, type: "v6" })
    const image = yield* Docker.Image("Image", {
      name: app.appName.pipe(Output.map((name) => `registry.fly.io/${name}`)),
      tag: deployment.imageTag,
      registry: { server: "registry.fly.io", username: "x", password: flyToken },
      build: {
        context: repositoryRoot,
        dockerfile: input.dockerfile,
        platform: "linux/amd64",
      },
    })
    const secrets = yield* Effect.forEach(Object.entries(input.secrets), ([name, value]) =>
      Fly.Secret(name, { app, name, value }).pipe(
        Effect.map(
          (secret) =>
            [
              `akter.secret.${name.toLowerCase()}`,
              secret.digest.pipe(Output.map((digest) => digest ?? "")),
            ] as const,
        ),
      ),
    )
    yield* Fly.Machine("Machine", {
      app,
      name: input.role,
      region: layout.region,
      count: input.count,
      image: image.imageRef,
      init: input.command === undefined ? undefined : { cmd: input.command },
      guest: { cpuKind: "shared", cpus: 1, memoryMb: input.memoryMb },
      env: input.env,
      services: publicService(layout, input),
      restart: { policy: "on-failure", maxRetries: 10 },
      deploy: { strategy: "rolling", healthTimeout: "5 minutes" },
      metadata: Object.fromEntries(secrets),
    })
    if (!layout.customDomains) return
    yield* Fly.Certificate("Certificate", { app, hostname: input.host })
    yield* cname(deployment, "Dns", input.host, layout.apps[input.role])
  })

const telemetryEnvironment = (layout: Layout, service: string) => ({
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.axiom.co",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
  OTEL_SERVICE_NAME: service,
  OTEL_RESOURCE_ATTRIBUTES: `deployment.environment=${layout.stage}`,
  AXIOM_DATASET: "akter-traces",
  AXIOM_LOG_DATASET: "akter-logs",
})

export interface ApplicationInputs {
  readonly deployment: Deployment
  readonly databaseUrl: Input<Redacted.Redacted<string>>
  readonly authSecret: Input<Redacted.Redacted<string>>
  readonly edgeSigningKeys: Input<Redacted.Redacted<string>>
  readonly stripeWebhookSecret: Input<Redacted.Redacted<string>>
  readonly telemetry: {
    readonly token: Input<Redacted.Redacted<string>>
    readonly traceHeaders: Input<Redacted.Redacted<string>>
    readonly logHeaders: Input<Redacted.Redacted<string>>
  }
}

/**
 * The four services of a stage in the stage's Fly organization: the API and the edge as Docker
 * machines, the console and the site as static builds. The API's runtime environment is the
 * contract the application reads; every secret reaches it as a Fly secret.
 */
export const applications = (inputs: ApplicationInputs) =>
  Effect.gen(function* () {
    const { deployment } = inputs
    const { layout, flyToken, stripeKey, resendApiKey } = deployment
    const origin = (host: string) => `https://${host}`
    const app = (role: keyof Layout["apps"]) =>
      Fly.App("App", { name: layout.apps[role], orgSlug: layout.flyOrganization })
    const telemetrySecrets = {
      AXIOM_TOKEN: inputs.telemetry.token,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: inputs.telemetry.traceHeaders,
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: inputs.telemetry.logHeaders,
    }

    const baseEnvironment = {
      NODE_ENV: "production",
      PORT: "3001",
      API_PORT: "3001",
      API_HOST: "0.0.0.0",
      API_PRODUCTION: "true",
      API_ORIGIN: origin(layout.hosts.api),
      CONSOLE_ORIGIN: origin(layout.hosts.console),
      EDGE_ORIGIN: origin(layout.hosts.edge),
      DEPLOYMENT_DOMAIN: layout.customerDomain,
      BILLING_MODE: "stripe",
      EMAIL_MODE: "resend",
      EMAIL_FROM: layout.emailFrom,
      RUNNER_FLY_CONFIG: runnerFlyConfig(layout),
      CONTROL_PLANE_DATABASE_ENGINE: "neki",
      ...telemetryEnvironment(layout, "api"),
    }
    const apiEnvironment = layout.customDomains
      ? baseEnvironment
      : { ...baseEnvironment, AUTH_COOKIE_SAME_SITE: "none" }

    yield* Effect.gen(function* () {
      const api = yield* app("api")
      yield* dockerService(deployment, {
        role: "api",
        app: api,
        host: layout.hosts.api,
        dockerfile: "apps/api/Dockerfile",
        port: 3001,
        check: { type: "http", path: "/ready" },
        memoryMb: 1024,
        count: 1,
        command: ["bun", "apps/api/src/main.ts"],
        env: apiEnvironment,
        secrets: {
          CONTROL_PLANE_DATABASE_URL: inputs.databaseUrl,
          AUTH_SECRET: inputs.authSecret,
          STRIPE_API_KEY: stripeKey,
          STRIPE_WEBHOOK_SECRET: inputs.stripeWebhookSecret,
          RESEND_API_KEY: resendApiKey,
          FLY_API_TOKEN: flyToken,
          ...telemetrySecrets,
        },
      })
    }).pipe(Namespace.push("api"))

    yield* Effect.gen(function* () {
      const edge = yield* app("edge")
      yield* dockerService(deployment, {
        role: "edge",
        app: edge,
        host: layout.hosts.edge,
        dockerfile: "apps/edge/Dockerfile",
        port: 3002,
        check: { type: "http", path: "/health" },
        memoryMb: 512,
        count: layout.edgeMachines,
        env: {
          NODE_ENV: "production",
          PORT: "3002",
          EDGE_ISSUER: origin(layout.hosts.edge),
          EDGE_TRUST_FLY_PROXY: "true",
          CONTROL_PLANE_DATABASE_ENGINE: "neki",
          ...telemetryEnvironment(layout, "edge"),
        },
        secrets: {
          CONTROL_PLANE_DATABASE_URL: inputs.databaseUrl,
          EDGE_SIGNING_KEYS: inputs.edgeSigningKeys,
          ...telemetrySecrets,
        },
      })
      const wildcard = yield* Fly.Certificate("CustomerWildcard", {
        app: edge,
        hostname: `*.${layout.customerDomain}`,
      })
      yield* Vercel.DnsRecord("CustomerWildcardDns", {
        domain: customerZone,
        teamId: deployment.vercelTeamId,
        name: relativeName({ zone: customerZone, host: `*.${layout.customerDomain}` }),
        type: "CNAME",
        value: flyHostname(layout.apps.edge),
      })
      yield* Vercel.DnsRecord("CustomerChallengeDns", {
        domain: customerZone,
        teamId: deployment.vercelTeamId,
        name: relativeName({
          zone: customerZone,
          host: `_acme-challenge.${layout.customerDomain}`,
        }),
        type: "CNAME",
        value: wildcard.dnsRequirements.pipe(
          Output.map((requirements) => {
            const target = requirements?.acmeChallenge?.target
            if (target === undefined)
              throw new Error(`Fly returned no ACME challenge for *.${layout.customerDomain}`)
            return target
          }),
        ),
      })
    }).pipe(Namespace.push("edge"))

    const services = publicService(layout, {
      port: 3000,
      check: { type: "tcp" },
      count: 1,
    })

    const web = yield* app("console").pipe(Namespace.push("console"))
    yield* Fly.IpAssignment("V6", { app: web, type: "v6" }).pipe(Namespace.push("console"))
    yield* Fly.Website.Foldkit("Web", {
      rootDir: `${repositoryRoot}/apps/console`,
      app: web,
      domain: layout.customDomains ? layout.hosts.console : undefined,
      env: { VITE_API_BASE_URL: origin(layout.hosts.api) },
      services,
    }).pipe(Namespace.push("console"))
    if (layout.customDomains)
      yield* cname(deployment, "Dns", layout.hosts.console, layout.apps.console).pipe(
        Namespace.push("console"),
      )

    const home = yield* app("site").pipe(Namespace.push("site"))
    const v6 = yield* Fly.IpAssignment("V6", { app: home, type: "v6" }).pipe(Namespace.push("site"))
    const site = yield* Fly.Website.Astro("Web", {
      rootDir: `${repositoryRoot}/apps/site`,
      app: home,
      domain: layout.customDomains ? layout.hosts.site : undefined,
      astro: { site: origin(layout.hosts.site), output: "static" },
      assets: { notFoundHandling: "404-page" },
      services,
    }).pipe(Namespace.push("site"))
    if (!layout.customDomains) return
    yield* Effect.gen(function* () {
      if (site.ip === undefined)
        return yield* Effect.die(new Error("The site has no shared address for its apex records"))
      yield* Vercel.DnsRecord("ApexA", {
        domain: platformZone,
        teamId: deployment.vercelTeamId,
        name: "",
        type: "A",
        value: site.ip.ip,
      })
      yield* Vercel.DnsRecord("ApexAaaa", {
        domain: platformZone,
        teamId: deployment.vercelTeamId,
        name: "",
        type: "AAAA",
        value: v6.ip,
      })
    }).pipe(Namespace.push("site"))
  })
