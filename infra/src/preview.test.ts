import { afterAll, describe, expect, it } from "vitest"
import { Effect, type Layer, ManagedRuntime, Schema } from "effect"
import * as Alchemy from "alchemy"
import { inMemoryState } from "alchemy/State"
import { stackName } from "./config.ts"
import { inspect, preview, previewLayer } from "./preview.ts"
import { stackProviders } from "./providers.ts"
import { resources } from "./stack.ts"

type Env = Layer.Success<typeof previewLayer>

const runtime = ManagedRuntime.make(previewLayer)
afterAll(() => runtime.dispose())

type Failure = Effect.Error<ReturnType<typeof preview>> | Schema.SchemaError

const test = (name: string, program: () => Effect.Effect<void, Failure, Env>) =>
  it(name, () => runtime.runPromise(Effect.suspend(program)))

const Service = Schema.Struct({
  internalPort: Schema.Int,
  autostart: Schema.Boolean,
  autostop: Schema.String,
  minMachinesRunning: Schema.Int,
  checks: Schema.Array(
    Schema.Struct({ type: Schema.String, port: Schema.Int, path: Schema.optional(Schema.String) }),
  ),
})
const AppProps = Schema.Struct({ name: Schema.String, orgSlug: Schema.String })
const Machine = Schema.Struct({
  app: Schema.Struct({ Props: AppProps }),
  name: Schema.String,
  region: Schema.String,
  count: Schema.Int,
  image: Schema.String,
  init: Schema.optional(Schema.Struct({ cmd: Schema.Array(Schema.String) })),
  guest: Schema.Struct({ cpuKind: Schema.String, cpus: Schema.Int, memoryMb: Schema.Int }),
  env: Schema.Record(Schema.String, Schema.String),
  services: Schema.Array(Service),
  metadata: Schema.Record(Schema.String, Schema.String),
})
const Website = Schema.Struct({ services: Schema.Array(Service) })
const Record = Schema.Struct({
  domain: Schema.String,
  name: Schema.String,
  type: Schema.String,
  value: Schema.String,
})
const Certificate = Schema.Struct({ hostname: Schema.String })
const Image = Schema.Struct({
  name: Schema.String,
  tag: Schema.String,
  registry: Schema.Struct({ server: Schema.String, username: Schema.String }),
  build: Schema.Struct({ dockerfile: Schema.String, platform: Schema.String }),
})
const Webhook = Schema.Struct({ url: Schema.String, enabledEvents: Schema.Array(Schema.String) })
const Comment = Schema.Struct({
  owner: Schema.String,
  repository: Schema.String,
  issueNumber: Schema.Int,
  body: Schema.String,
})

const json = Schema.fromJsonString(Schema.Unknown)
const encodeJson = Schema.encodeEffect(json)
const decodeJson = Schema.decodeUnknownEffect(json)

const decode = {
  app: Schema.decodeUnknownEffect(AppProps),
  machine: Schema.decodeUnknownEffect(Machine),
  website: Schema.decodeUnknownEffect(Website),
  record: Schema.decodeUnknownEffect(Record),
  certificate: Schema.decodeUnknownEffect(Certificate),
  image: Schema.decodeUnknownEffect(Image),
  webhook: Schema.decodeUnknownEffect(Webhook),
  comment: Schema.decodeUnknownEffect(Comment),
}

const types = <T extends { type: string }>(graph: { resources: ReadonlyArray<T> }, type: string) =>
  graph.resources.filter((resource) => resource.type === type)

const ids = (graph: { resources: ReadonlyArray<{ id: string; type: string }> }, type: string) =>
  types(graph, type)
    .map(({ id }) => id)
    .sort()

const removalOf = (
  graph: { resources: ReadonlyArray<{ id: string; removal: string }> },
  id: string,
) => graph.resources.find((resource) => resource.id === id)?.removal

const apiSecrets = [
  "AUTH_SECRET",
  "AXIOM_TOKEN",
  "CONTROL_PLANE_DATABASE_URL",
  "FLY_API_TOKEN",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "RESEND_API_KEY",
  "STRIPE_API_KEY",
  "STRIPE_WEBHOOK_SECRET",
]
const edgeSecrets = [
  "AXIOM_TOKEN",
  "CONTROL_PLANE_DATABASE_URL",
  "EDGE_SIGNING_KEYS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
]

const stages = [
  {
    stage: "prod",
    organization: "rika-labs-prod",
    other: "rika-labs-dev",
    api: "api.akter.dev",
    edge: "edge.akter.dev",
    console: "app.akter.dev",
    site: "akter.dev",
    customer: "akter.run",
    from: "Akter <auth@akter.dev>",
    app: "akter-prod",
    prefix: "akter-prod-run-",
    environment: {},
    wildcard: { name: "*", challenge: "_acme-challenge" },
  },
  {
    stage: "pr-23",
    organization: "rika-labs-dev",
    other: "rika-labs-prod",
    api: "akter-pr-23-api.fly.dev",
    edge: "akter-pr-23-edge.fly.dev",
    console: "akter-pr-23-console.fly.dev",
    site: "akter-pr-23-site.fly.dev",
    customer: "pr-23.preview.akter.run",
    from: "Akter Preview <auth-preview@akter.dev>",
    app: "akter-pr-23",
    prefix: "akter-pr23-run-",
    environment: { AUTH_COOKIE_SAME_SITE: "none" },
    wildcard: { name: "*.pr-23.preview", challenge: "_acme-challenge.pr-23.preview" },
  },
]

describe("credential-free resource graph", () => {
  for (const expected of stages) {
    describe(expected.stage, () => {
      const graph = preview({ stage: expected.stage })

      test("registers every resource's provider under one stack name", () =>
        Effect.gen(function* () {
          const compiled = yield* graph
          expect(compiled.stage).toBe(expected.stage)
          expect(compiled.name).toBe("akter")
          expect(ids(compiled, "Fly.Machine")).toEqual(["api/Machine", "edge/Machine"])
        }))

      test("keeps every Fly app in the stage's own organization", () =>
        Effect.gen(function* () {
          const compiled = yield* graph
          const apps = yield* Effect.forEach(ids(compiled, "Fly.App"), (id) =>
            decode.app(compiled.declarations[id]),
          )
          expect(apps.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
            ["api", "console", "edge", "site"].map((role) => ({
              name: `${expected.app}-${role}`,
              orgSlug: expected.organization,
            })),
          )
          expect(yield* encodeJson(compiled.declarations)).not.toContain(expected.other)
        }))

      test("gives the API its runtime environment and only its own secrets", () =>
        Effect.gen(function* () {
          const compiled = yield* graph
          const machine = yield* decode.machine(compiled.declarations["api/Machine"])
          const { RUNNER_FLY_CONFIG: runner, ...environment } = machine.env
          expect(yield* decodeJson(runner)).toEqual({
            organization: expected.organization,
            regions: { "us-east-1": { region: "iad" } },
            port: 8080,
            appPrefix: expected.prefix,
            guest: { cpuKind: "shared", cpus: 1, memoryMb: 512 },
          })
          expect(environment).toEqual({
            NODE_ENV: "production",
            PORT: "3001",
            API_PORT: "3001",
            API_HOST: "0.0.0.0",
            API_PRODUCTION: "true",
            API_ORIGIN: `https://${expected.api}`,
            CONSOLE_ORIGIN: `https://${expected.console}`,
            ...expected.environment,
            EDGE_ORIGIN: `https://${expected.edge}`,
            DEPLOYMENT_DOMAIN: expected.customer,
            BILLING_MODE: "stripe",
            EMAIL_MODE: "resend",
            CONTROL_PLANE_DATABASE_ENGINE: "neki",
            EMAIL_FROM: expected.from,
            OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.axiom.co",
            OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
            OTEL_SERVICE_NAME: "api",
            OTEL_RESOURCE_ATTRIBUTES: `deployment.environment=${expected.stage}`,
            AXIOM_DATASET: "akter-traces",
            AXIOM_LOG_DATASET: "akter-logs",
          })
          expect(machine.init?.cmd).toEqual(["bun", "apps/api/src/main.ts"])
          expect(machine.region).toBe("iad")
          expect(machine.count).toBe(1)
          expect(
            ids(compiled, "Fly.Secret")
              .filter((id) => id.startsWith("api/"))
              .map((id) => id.slice(4)),
          ).toEqual(apiSecrets)
          expect(Object.keys(machine.env).filter((name) => apiSecrets.includes(name))).toEqual([])
          expect(Object.keys(machine.metadata).sort()).toEqual(
            apiSecrets.map((name) => `akter.secret.${name.toLowerCase()}`),
          )
        }))

      test("gives the edge the Fly proxy for client addresses and only its own secrets", () =>
        Effect.gen(function* () {
          const compiled = yield* graph
          const machine = yield* decode.machine(compiled.declarations["edge/Machine"])
          expect(machine.env).toEqual({
            NODE_ENV: "production",
            PORT: "3002",
            EDGE_ISSUER: `https://${expected.edge}`,
            EDGE_TRUST_FLY_PROXY: "true",
            CONTROL_PLANE_DATABASE_ENGINE: "neki",
            OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.axiom.co",
            OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
            OTEL_SERVICE_NAME: "edge",
            OTEL_RESOURCE_ATTRIBUTES: `deployment.environment=${expected.stage}`,
            AXIOM_DATASET: "akter-traces",
            AXIOM_LOG_DATASET: "akter-logs",
          })
          expect(machine.count).toBe(expected.stage === "prod" ? 2 : 1)
          expect(machine.init).toBeUndefined()
          expect(
            ids(compiled, "Fly.Secret")
              .filter((id) => id.startsWith("edge/"))
              .map((id) => id.slice(5)),
          ).toEqual(edgeSecrets)
        }))

      test("builds amd64 images for Fly's registry from the repository's Dockerfiles", () =>
        Effect.gen(function* () {
          const compiled = yield* graph
          for (const [role, dockerfile] of [
            ["api", "apps/api/Dockerfile"],
            ["edge", "apps/edge/Dockerfile"],
          ] as const) {
            const image = yield* decode.image(compiled.declarations[`${role}/Image`])
            const machine = yield* decode.machine(compiled.declarations[`${role}/Machine`])
            expect(image).toMatchObject({
              name: `registry.fly.io/${role}/App.appName`,
              registry: { server: "registry.fly.io", username: "x" },
              build: { dockerfile, platform: "linux/amd64" },
            })
            expect(machine.image).toBe(`${role}/Image.imageRef`)
          }
        }))

      test("stops idle machines of a preview only", () =>
        Effect.gen(function* () {
          const compiled = yield* graph
          const sleeps = expected.stage.startsWith("pr-")
          for (const id of ["api/Machine", "edge/Machine"]) {
            const machine = yield* decode.machine(compiled.declarations[id])
            expect(machine.services).toHaveLength(1)
            expect(machine.services[0]).toMatchObject({
              autostart: true,
              autostop: sleeps ? "stop" : "off",
              minMachinesRunning: sleeps ? 0 : machine.count,
            })
          }
          for (const id of ["console/Web/Service", "site/Web/Service"]) {
            const website = yield* decode.website(compiled.declarations[id])
            expect(website.services[0]).toMatchObject({
              autostart: true,
              autostop: sleeps ? "stop" : "off",
              minMachinesRunning: sleeps ? 0 : 1,
            })
          }
        }))

      test("probes the API and the edge on the routes they serve", () =>
        Effect.gen(function* () {
          const compiled = yield* graph
          const api = yield* decode.machine(compiled.declarations["api/Machine"])
          const edge = yield* decode.machine(compiled.declarations["edge/Machine"])
          expect(api.services[0]).toMatchObject({
            internalPort: 3001,
            checks: [{ type: "http", port: 3001, path: "/ready" }],
          })
          expect(edge.services[0]).toMatchObject({
            internalPort: 3002,
            checks: [{ type: "http", port: 3002, path: "/health" }],
          })
        }))

      test("certifies the platform hostnames of prod only, and the customer wildcard on the edge", () =>
        Effect.gen(function* () {
          const compiled = yield* graph
          const hostnames = yield* Effect.forEach(ids(compiled, "Fly.Certificate"), (id) =>
            Effect.map(
              decode.certificate(compiled.declarations[id]),
              ({ hostname }) => [id, hostname] as const,
            ),
          )
          const customer = { "edge/CustomerWildcard": `*.${expected.customer}` }
          expect(Object.fromEntries(hostnames)).toEqual(
            expected.stage === "prod"
              ? {
                  "api/Certificate": expected.api,
                  "console/Web/Certificate": expected.console,
                  "edge/Certificate": expected.edge,
                  ...customer,
                  "site/Web/Certificate": expected.site,
                }
              : customer,
          )
        }))

      test("publishes the platform hostnames of prod only, and the customer wildcard in its own zone", () =>
        Effect.gen(function* () {
          const compiled = yield* graph
          const records = yield* Effect.forEach(ids(compiled, "Vercel.DnsRecord"), (id) =>
            Effect.map(decode.record(compiled.declarations[id]), (record) => [id, record] as const),
          )
          const byId = Object.fromEntries(records)
          const cname = (domain: string, name: string, role: string) => ({
            domain,
            name,
            type: "CNAME",
            value: `${expected.app}-${role}.fly.dev`,
          })
          expect(byId["edge/CustomerWildcardDns"]).toEqual(
            cname("akter.run", expected.wildcard.name, "edge"),
          )
          expect(byId["edge/CustomerChallengeDns"]).toMatchObject({
            domain: "akter.run",
            name: expected.wildcard.challenge,
            type: "CNAME",
          })
          if (expected.stage === "prod") {
            expect(byId["api/Dns"]).toEqual(cname("akter.dev", "api", "api"))
            expect(byId["edge/Dns"]).toEqual(cname("akter.dev", "edge", "edge"))
            expect(byId["console/Dns"]).toEqual(cname("akter.dev", "app", "console"))
            expect(byId["site/ApexA"]).toEqual({
              domain: "akter.dev",
              name: "",
              type: "A",
              value: "site/Web/Shared.ip",
            })
            expect(byId["site/ApexAaaa"]).toEqual({
              domain: "akter.dev",
              name: "",
              type: "AAAA",
              value: "site/V6.ip",
            })
            expect(byId["site/Dns"]).toBeUndefined()
          } else {
            expect(Object.keys(byId).sort()).toEqual([
              "edge/CustomerChallengeDns",
              "edge/CustomerWildcardDns",
            ])
            expect(records.filter(([, { domain }]) => domain === "akter.dev")).toEqual([])
          }
          for (const record of Object.values(byId)) {
            expect(record.name.endsWith(record.domain)).toBe(false)
            expect(record.name.endsWith(".")).toBe(false)
          }
        }))

      test("declares no hostname under the retired preview zone", () =>
        Effect.gen(function* () {
          const compiled = yield* graph
          expect(yield* encodeJson(compiled.declarations)).not.toContain("preview.akter.dev")
        }))

      test("builds the console against its own API", () =>
        Effect.gen(function* () {
          const compiled = yield* graph
          expect(compiled.declarations["console/Web/Service"]).toMatchObject({
            env: { VITE_API_BASE_URL: `https://${expected.api}` },
          })
        }))

      test("receives Stripe events at its own API", () =>
        Effect.gen(function* () {
          const compiled = yield* graph
          const webhook = yield* decode.webhook(compiled.declarations["Billing"])
          expect(webhook.url).toBe(`https://${expected.api}/api/billing/webhook`)
          expect(webhook.enabledEvents).toEqual(
            expect.arrayContaining([
              "checkout.session.completed",
              "customer.subscription.updated",
              "invoice.payment_failed",
            ]),
          )
          expect(ids(compiled, "Stripe.WebhookEndpoint")).toEqual(["Billing"])
        }))

      test("never leaves a secret value in a declaration", () =>
        Effect.gen(function* () {
          const compiled = yield* graph
          expect(yield* encodeJson(compiled.declarations)).not.toContain(
            "nonfunctional-offline-placeholder",
          )
        }))
    })
  }
})

describe("shared services", () => {
  test("keeps the Axiom datasets within the free plan, retained, and the monitor on prod", () =>
    Effect.gen(function* () {
      for (const stage of ["preview", "prod"]) {
        const graph = yield* preview({ stage })
        expect(ids(graph, "Axiom.Dataset")).toEqual(["Logs", "Traces"])
        expect(
          graph.resources
            .filter(({ type }) => type === "Axiom.Dataset")
            .map(({ removal }) => removal),
        ).toEqual(["retain", "retain"])
      }
      const production = yield* preview({ stage: "prod" })
      expect(ids(production, "Axiom.Monitor")).toEqual(["ServiceErrors"])
      expect(removalOf(production, "ServiceErrors")).toBe("destroy")
      expect(production.declarations["ServiceErrors"]).toMatchObject({
        aplQuery: expect.stringContaining("== 'prod'"),
      })
      const request = yield* preview({ stage: "pr-4" })
      expect(types(request, "Axiom.Dataset")).toEqual([])
      expect(types(request, "Axiom.Monitor")).toEqual([])
      for (const stage of ["prod", "pr-4"])
        expect(ids(yield* preview({ stage }), "Axiom.ApiToken")).toEqual(["TelemetryIngest"])
    }))

  test("leaves the sending domain and its mail records to Resend and Vercel by hand", () =>
    Effect.gen(function* () {
      for (const stage of ["preview", "prod", "pr-4"]) {
        const graph = yield* preview({ stage })
        expect(graph.resources.filter(({ type }) => type.startsWith("Resend."))).toEqual([])
        const records = yield* Effect.forEach(ids(graph, "Vercel.DnsRecord"), (id) =>
          decode.record(graph.declarations[id]),
        )
        const names = records.filter(({ domain }) => domain === "akter.dev").map(({ name }) => name)
        for (const mail of ["send", "rsend", "resend._domainkey", "_dmarc"])
          expect(names).not.toContain(mail)
        expect(
          records.filter(
            ({ domain, name, type }) =>
              domain === "akter.dev" && name === "" && (type === "MX" || type === "TXT"),
          ),
        ).toEqual([])
      }
    }))
})

describe("preview stage", () => {
  test("declares the shared cluster and datasets and runs no application", () =>
    Effect.gen(function* () {
      const graph = yield* preview({ stage: "preview" })
      expect(graph.resources.map(({ type }) => type).sort()).toEqual([
        "Axiom.Dataset",
        "Axiom.Dataset",
        "Planetscale.NekiDatabase",
      ])
    }))

  test("needs no credential of the services it does not run", () =>
    Effect.gen(function* () {
      const graph = yield* inspect({
        stack: Alchemy.Stack(
          stackName,
          { providers: stackProviders, state: inMemoryState() },
          resources,
        ),
        stage: "preview",
        environment: {
          AXIOM_TOKEN: "nonfunctional-offline-placeholder",
          AXIOM_URL: "http://127.0.0.1:1",
          PLANETSCALE_API_TOKEN_ID: "placeholder",
          PLANETSCALE_API_TOKEN: "nonfunctional-offline-placeholder",
          PLANETSCALE_ORGANIZATION: "placeholder",
          PLANETSCALE_API_BASE_URL: "http://127.0.0.1:1",
          NEKI_CLUSTER_SIZE: "PS_10",
          NEKI_ROUTER_SIZE: "NKR_1",
        },
      })
      expect(ids(graph, "Planetscale.NekiDatabase")).toEqual(["Database"])
    }))
})

describe("control-plane database", () => {
  test("gives the preview stage the smallest Neki cluster and no role", () =>
    Effect.gen(function* () {
      const graph = yield* preview({ stage: "preview" })
      expect(ids(graph, "Planetscale.NekiDatabase")).toEqual(["Database"])
      expect(types(graph, "Planetscale.NekiRole")).toEqual([])
      expect(types(graph, "Planetscale.NekiLogicalDatabase")).toEqual([])
      expect(graph.declarations["Database"]).toMatchObject({
        name: "akter-preview",
        region: "us-east",
        clusterSize: "PS_10",
        replicas: 0,
        shardCount: 1,
        routers: [{ name: "default", size: "NKR_1", replicasPerCell: 1 }],
        deletionProtected: false,
        unshardedTables: expect.arrayContaining(["deployment", "actor_placements"]),
      })
      expect(removalOf(graph, "Database")).toBe("destroy")
    }))

  test("keeps the preview stage at one shard however many prod runs", () =>
    Effect.gen(function* () {
      const overrides = { NEKI_SHARD_COUNT: "4" }
      const shared = yield* preview({ stage: "preview", overrides })
      const production = yield* preview({ stage: "prod", overrides })
      expect(shared.declarations["Database"]).toMatchObject({ shardCount: 1 })
      expect(production.declarations["Database"]).toMatchObject({ shardCount: 4 })
    }))

  test("gives prod a Neki database, retained and protected, and a role for the services", () =>
    Effect.gen(function* () {
      const graph = yield* preview({ stage: "prod" })
      expect(ids(graph, "Planetscale.NekiDatabase")).toEqual(["Database"])
      expect(ids(graph, "Planetscale.NekiRole")).toEqual(["ServiceRole"])
      expect(types(graph, "Planetscale.NekiLogicalDatabase")).toEqual([])
      expect(graph.declarations["Database"]).toMatchObject({
        name: "akter-production",
        region: "us-east",
        replicas: 2,
        deletionProtected: true,
        unshardedTables: expect.arrayContaining(["deployment", "actor_placements"]),
      })
      expect(removalOf(graph, "Database")).toBe("retain")
    }))

  test("gives a preview a role and a logical database on the preview stage's cluster, never a cluster", () =>
    Effect.gen(function* () {
      const graph = yield* preview({ stage: "pr-23" })
      expect(types(graph, "Planetscale.NekiDatabase")).toEqual([])
      expect(ids(graph, "Planetscale.NekiRole")).toEqual(["PreviewRole"])
      expect(ids(graph, "Planetscale.NekiLogicalDatabase")).toEqual(["PreviewDatabase"])
      expect(graph.declarations["PreviewDatabase"]).toMatchObject({ name: "akter_pr_23" })
      expect(graph.declarations["PreviewRole"]).toMatchObject({
        organization: expect.stringContaining(
          "stackRef(akter, { stage: preview }).neki.organization",
        ),
        database: expect.stringContaining("stackRef(akter, { stage: preview }).neki.database"),
        branch: expect.stringContaining("stackRef(akter, { stage: preview }).neki.branch"),
        inheritedRoles: ["postgres", "pg_read_all_data", "neki_viewer"],
      })
      expect(removalOf(graph, "PreviewDatabase")).toBe("destroy")
      expect(removalOf(graph, "PreviewRole")).toBe("destroy")
    }))

  test("hands the services no customer-environment key", () =>
    Effect.gen(function* () {
      for (const stage of ["prod", "pr-5"])
        expect(types(yield* preview({ stage }), "Fly.SecretKey")).toEqual([])
    }))
})

describe("pull request comment", () => {
  test("posts the preview URLs on the pull request of a preview stage only", () =>
    Effect.gen(function* () {
      const graph = yield* preview({ stage: "pr-23" })
      const comment = yield* decode.comment(graph.declarations["PreviewUrls"])
      expect(comment).toMatchObject({ owner: "Rika-Labs", repository: "akter", issueNumber: 23 })
      for (const url of [
        "https://akter-pr-23-site.fly.dev",
        "https://akter-pr-23-console.fly.dev",
        "https://akter-pr-23-api.fly.dev",
        "https://akter-pr-23-edge.fly.dev",
        "*.pr-23.preview.akter.run",
      ])
        expect(comment.body).toContain(url)
      expect(comment.body).not.toContain("preview.akter.dev")
      expect(comment.body).toContain("partitioned cross-site cookies")
      for (const stage of ["preview", "prod"])
        expect(types(yield* preview({ stage }), "GitHub.Comment")).toEqual([])
    }))

  test("posts nothing without a pull request number", () =>
    Effect.gen(function* () {
      const outside = yield* preview({ stage: "pr-23", overrides: { GITHUB_ACTIONS: "false" } })
      expect(types(outside, "GitHub.Comment")).toEqual([])
      const manual = yield* preview({ stage: "pr-23", overrides: { PULL_REQUEST: "" } })
      expect(types(manual, "GitHub.Comment")).toEqual([])
    }))

  test("refuses to comment on another pull request than the stage's", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.exit(
        preview({ stage: "pr-23", overrides: { PULL_REQUEST: "24" } }),
      )
      expect(outcome._tag).toBe("Failure")
      expect(String(outcome)).toContain("cannot comment on pull request 24")
    }))
})

describe("stage rules", () => {
  for (const stage of ["staging", "dev", "pr-0", "production"])
    test(`rejects the stage ${stage}`, () =>
      Effect.gen(function* () {
        const outcome = yield* Effect.exit(preview({ stage }))
        expect(outcome._tag).toBe("Failure")
        expect(String(outcome)).toContain("Unsupported stage")
      }))

  test("refuses a Stripe key of the wrong mode", () =>
    Effect.gen(function* () {
      const request = yield* Effect.exit(
        preview({
          stage: "pr-4",
          overrides: { STRIPE_API_KEY: "sk_live_nonfunctional-offline-placeholder" },
        }),
      )
      expect(String(request)).toContain("test mode")
      const prod = yield* Effect.exit(
        preview({
          stage: "prod",
          overrides: { STRIPE_API_KEY: "sk_test_nonfunctional-offline-placeholder" },
        }),
      )
      expect(String(prod)).toContain("live mode")
    }))

  test("bills production in test mode only when its environment says so", () =>
    Effect.gen(function* () {
      const chosen = yield* Effect.exit(
        preview({
          stage: "prod",
          overrides: {
            STRIPE_MODE: "test",
            STRIPE_API_KEY: "sk_test_nonfunctional-offline-placeholder",
          },
        }),
      )
      expect(chosen._tag).toBe("Success")
      const unset = yield* Effect.exit(
        preview({ stage: "prod", overrides: { STRIPE_MODE: undefined } }),
      )
      expect(unset._tag).toBe("Failure")
      expect(String(unset)).toContain("STRIPE_MODE")
      const preview5 = yield* Effect.exit(
        preview({
          stage: "pr-5",
          overrides: {
            STRIPE_MODE: "live",
            STRIPE_API_KEY: "sk_live_nonfunctional-offline-placeholder",
          },
        }),
      )
      expect(String(preview5)).toContain("test mode")
    }))
})
