import * as Alchemy from "alchemy"
import * as Axiom from "alchemy/Axiom"
import * as GitHub from "alchemy/GitHub"
import { inMemoryState } from "alchemy/State"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { inspect, previewLayer } from "../preview.ts"
import { environments } from "./environments.ts"

const runtime = ManagedRuntime.make(previewLayer)
afterAll(() => runtime.dispose())

const stack = Alchemy.Stack(
  "akter-github",
  { providers: Layer.mergeAll(GitHub.providers(), Axiom.providers()), state: inMemoryState() },
  environments,
)

const inputs = {
  PLANETSCALE_ORGANIZATION: "planetscale-org",
  VERCEL_TOKEN: "vercel-token",
  AXIOM_NOTIFIER_ID: "notifier",
  AXIOM_TOKEN: "axiom-admin",
  AXIOM_URL: "http://127.0.0.1:1",
  PREVIEW_ALCHEMY_STATE_DATABASE_URL: "state-preview",
  PREVIEW_PLANETSCALE_API_TOKEN_ID: "planetscale-id-preview",
  PREVIEW_PLANETSCALE_API_TOKEN: "planetscale-token-preview",
  PREVIEW_RESEND_API_KEY: "resend-preview",
  PREVIEW_FLY_API_TOKEN: "fly-preview",
  PREVIEW_STRIPE_API_KEY: "stripe-preview",
  PREVIEW_NEKI_CLUSTER_SIZE: "PS_10",
  PREVIEW_NEKI_ROUTER_SIZE: "NKR_1",
  PRODUCTION_ALCHEMY_STATE_DATABASE_URL: "state-prod",
  PRODUCTION_PLANETSCALE_API_TOKEN_ID: "planetscale-id-prod",
  PRODUCTION_PLANETSCALE_API_TOKEN: "planetscale-token-prod",
  PRODUCTION_RESEND_API_KEY: "resend-prod",
  PRODUCTION_FLY_API_TOKEN: "fly-prod",
  PRODUCTION_STRIPE_API_KEY: "stripe-prod",
  PRODUCTION_NEKI_CLUSTER_SIZE: "PS_80",
  PRODUCTION_NEKI_ROUTER_SIZE: "NKR_2",
  PRODUCTION_NEKI_SHARD_COUNT: "4",
}

const Environment = Schema.Struct({
  name: Schema.String,
  reviewers: Schema.optional(Schema.Unknown),
  deploymentBranchPolicy: Schema.optional(
    Schema.Struct({ customBranchPolicies: Schema.Array(Schema.String) }),
  ),
})
const Setting = Schema.Struct({
  name: Schema.String,
  environment: Schema.Struct({ Props: Schema.Struct({ name: Schema.String }) }),
  value: Schema.Unknown,
})
const Token = Schema.Struct({
  name: Schema.String,
  orgCapabilities: Schema.Record(Schema.String, Schema.Array(Schema.String)),
})

const decode = {
  environment: Schema.decodeUnknownEffect(Environment),
  setting: Schema.decodeUnknownEffect(Setting),
  token: Schema.decodeUnknownEffect(Token),
}

const compile = (overrides: { readonly [name: string]: string } = {}) =>
  inspect({ stack, stage: "github", environment: { ...inputs, ...overrides } })

type Failure = Effect.Error<ReturnType<typeof compile>> | Schema.SchemaError

type Env = Layer.Success<typeof previewLayer>

const test = (name: string, program: () => Effect.Effect<void, Failure, Env>) =>
  it(name, () => runtime.runPromise(Effect.suspend(program)))

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

type Graph = Effect.Success<ReturnType<typeof compile>>

const settings = (graph: Graph, type: string, environment: string) =>
  Effect.gen(function* () {
    const found = yield* Effect.forEach(
      graph.resources.filter((resource) => resource.type === type).map(({ id }) => id),
      (id) => decode.setting(graph.declarations[id]),
    )
    return Object.fromEntries(
      found
        .filter((setting) => setting.environment.Props.name === environment)
        .map((setting) => [
          setting.name,
          Redacted.isRedacted(setting.value) ? Redacted.value(setting.value) : setting.value,
        ]),
    )
  })

describe("GitHub environments", () => {
  test("writes the preview and production environments and nothing else", () =>
    Effect.gen(function* () {
      const graph = yield* compile()
      expect(graph.resources.filter(({ type }) => type === "GitHub.Environment")).toHaveLength(2)
      expect(graph.resources.every(({ id }) => /^(preview|production)\//.test(id))).toBe(true)
    }))

  test("opens production to deployments from main alone and asks no one to approve them", () =>
    Effect.gen(function* () {
      const graph = yield* compile()
      const preview = yield* decode.environment(graph.declarations["preview/preview"])
      const production = yield* decode.environment(graph.declarations["production/production"])
      expect(production).toEqual({
        name: "production",
        deploymentBranchPolicy: { customBranchPolicies: ["main"] },
      })
      expect(preview).toEqual({ name: "preview" })
    }))

  test("gives each environment its own credentials and shares only the Vercel token", () =>
    Effect.gen(function* () {
      const graph = yield* compile()
      const preview = yield* settings(graph, "GitHub.Secret", "preview")
      const production = yield* settings(graph, "GitHub.Secret", "production")
      expect(preview).toMatchObject({
        ALCHEMY_STATE_DATABASE_URL: "state-preview",
        PLANETSCALE_API_TOKEN_ID: "planetscale-id-preview",
        PLANETSCALE_API_TOKEN: "planetscale-token-preview",
        RESEND_API_KEY: "resend-preview",
        FLY_API_TOKEN: "fly-preview",
        STRIPE_API_KEY: "stripe-preview",
        VERCEL_TOKEN: "vercel-token",
      })
      expect(production).toMatchObject({
        ALCHEMY_STATE_DATABASE_URL: "state-prod",
        PLANETSCALE_API_TOKEN_ID: "planetscale-id-prod",
        PLANETSCALE_API_TOKEN: "planetscale-token-prod",
        RESEND_API_KEY: "resend-prod",
        FLY_API_TOKEN: "fly-prod",
        STRIPE_API_KEY: "stripe-prod",
        VERCEL_TOKEN: "vercel-token",
      })
      const differing = Object.keys(preview).filter((name) => preview[name] !== production[name])
      expect(differing.sort()).toEqual([
        "ALCHEMY_STATE_DATABASE_URL",
        "AXIOM_TOKEN",
        "FLY_API_TOKEN",
        "PLANETSCALE_API_TOKEN",
        "PLANETSCALE_API_TOKEN_ID",
        "RESEND_API_KEY",
        "STRIPE_API_KEY",
      ])
      expect(Object.keys(preview).sort()).toEqual(Object.keys(production).sort())
    }))

  test("hands each environment the Axiom token minted for it, not the one running the stack", () =>
    Effect.gen(function* () {
      const graph = yield* compile()
      const preview = yield* settings(graph, "GitHub.Secret", "preview")
      const production = yield* settings(graph, "GitHub.Secret", "production")
      expect(preview["AXIOM_TOKEN"]).toBe("preview/AxiomToken.token")
      expect(production["AXIOM_TOKEN"]).toBe("production/AxiomToken.token")
      expect(yield* encodeJson(graph.declarations)).not.toContain("axiom-admin")
    }))

  test("lets only production manage the monitor", () =>
    Effect.gen(function* () {
      const graph = yield* compile()
      const preview = yield* decode.token(graph.declarations["preview/AxiomToken"])
      const production = yield* decode.token(graph.declarations["production/AxiomToken"])
      expect(preview.orgCapabilities).toEqual({
        datasets: ["create", "read", "update", "delete"],
        apiTokens: ["create", "read", "delete"],
      })
      expect(production.orgCapabilities).toEqual({
        datasets: ["create", "read", "update", "delete"],
        monitors: ["create", "read", "update", "delete"],
        notifiers: ["read"],
        apiTokens: ["create", "read", "delete"],
      })
      expect(production.name).not.toBe(preview.name)
    }))

  test("sizes Neki for each environment and notifies from production only", () =>
    Effect.gen(function* () {
      const graph = yield* compile()
      const preview = yield* settings(graph, "GitHub.Variable", "preview")
      const production = yield* settings(graph, "GitHub.Variable", "production")
      expect(preview).toEqual({
        PLANETSCALE_ORGANIZATION: "planetscale-org",
        NEKI_CLUSTER_SIZE: "PS_10",
        NEKI_ROUTER_SIZE: "NKR_1",
      })
      expect(production).toEqual({
        PLANETSCALE_ORGANIZATION: "planetscale-org",
        NEKI_CLUSTER_SIZE: "PS_80",
        NEKI_ROUTER_SIZE: "NKR_2",
        NEKI_SHARD_COUNT: "4",
        AXIOM_NOTIFIER_ID: "notifier",
      })
    }))

  test("writes the optional team and organization ids only when they are given", () =>
    Effect.gen(function* () {
      const given = yield* compile({ VERCEL_TEAM_ID: "team_1", AXIOM_ORG_ID: "org-1" })
      for (const environment of ["preview", "production"])
        expect(yield* settings(given, "GitHub.Variable", environment)).toMatchObject({
          VERCEL_TEAM_ID: "team_1",
          AXIOM_ORG_ID: "org-1",
        })
      const absent = yield* settings(yield* compile(), "GitHub.Variable", "production")
      expect(Object.keys(absent)).not.toContain("VERCEL_TEAM_ID")
      expect(Object.keys(absent)).not.toContain("AXIOM_ORG_ID")
    }))
})
