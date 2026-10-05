import * as Alchemy from "alchemy"
import { AlchemyContext } from "alchemy/AlchemyContext"
import { provideFreshArtifactStore } from "alchemy/Artifacts"
import { layerNonInteractive } from "alchemy/Interaction"
import * as Output from "alchemy/Output"
import { tryFindProviderByType } from "alchemy/Provider"
import { evalStack, type CompiledStack, type StackEffect } from "alchemy/Stack"
import type { Stage } from "alchemy/Stage"
import { inMemoryState, type State } from "alchemy/State"
import { BunServices } from "@effect/platform-bun"
import {
  ConfigProvider,
  Console,
  Effect,
  Layer,
  ManagedRuntime,
  Predicate,
  Redacted,
  Schema,
} from "effect"
import type { ConfigError } from "effect/Config"
import type { PlatformError } from "effect/PlatformError"
import { stackName } from "./config.ts"
import { stackProviders } from "./providers.ts"
import { resources } from "./stack.ts"

export const previewLayer = Layer.mergeAll(
  BunServices.layer,
  layerNonInteractive(),
  inMemoryState(),
)

/** Declaration types whose resolved props the preview returns. */
const inspectedTypes = new Set([
  "Fly.App",
  "Fly.Machine",
  "Fly.Service",
  "Fly.Certificate",
  "Fly.Secret",
  "Fly.SecretKey",
  "Fly.IpAssignment",
  "Docker.Image",
  "Vercel.DnsRecord",
  "Planetscale.NekiDatabase",
  "Planetscale.NekiRole",
  "Planetscale.NekiLogicalDatabase",
  "Stripe.WebhookEndpoint",
  "GitHub.Comment",
  "GitHub.Environment",
  "GitHub.Secret",
  "GitHub.Variable",
  "Axiom.ApiToken",
  "Axiom.Monitor",
])

/**
 * A resource before any deploy: each attribute reads as `<logical id>.<attribute>`,
 * so a resolved declaration names the resource it references without a cloud call.
 */
const symbolic = (id: string) =>
  new Proxy<Symbolic>(
    {},
    {
      get: (_, attribute) => (Predicate.isString(attribute) ? `${id}.${attribute}` : undefined),
    },
  )

const customInspect = Symbol.for("nodejs.util.inspect.custom")

export interface Graph {
  readonly stage: string
  readonly name: string
  readonly resources: ReadonlyArray<{
    readonly id: string
    readonly type: string
    readonly removal: "destroy" | "retain"
  }>
  readonly declarations: { readonly [id: string]: Declared }
}

/** A prop as the preview walks it: a plain value, an output, or a container of either. */
export type Declared =
  | Output.Output
  | Redacted.Redacted
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<Declared>
  | { readonly [key: string]: Declared }

type Symbolic = { readonly [attribute: string]: string }

type Upstream = { readonly [fqn: string]: Symbolic }

/** Names where an output comes from, such as `stackRef(akter, { stage: preview }).neki.database`. */
const describe = (output: Output.Output) => {
  const read = Predicate.hasProperty(output, customInspect) ? output[customInspect] : undefined
  return `<computed ${Predicate.isFunction(read) ? String(read.call(output)) : ""}>`
}

/**
 * Resolves each output in `value` against the symbolic upstream. An output computed from
 * attributes only a deploy produces cannot run on a symbolic one, so it reads as a description
 * of where it comes from.
 */
const settle = (value: Declared, upstream: Upstream): Effect.Effect<Declared, never, State> => {
  if (Output.isOutput(value))
    return Output.evaluate<Declared, never>(value, upstream).pipe(
      Effect.catchCause(() => Effect.succeed(describe(value))),
    )
  if (Array.isArray(value)) return Effect.forEach(value, (item) => settle(item, upstream))
  if (Predicate.isObject(value) && !Redacted.isRedacted(value))
    return Effect.forEach(Object.entries(value), ([key, item]) =>
      Effect.map(settle(item, upstream), (settled) => [key, settled] as const),
    ).pipe(Effect.map((entries) => Object.fromEntries(entries)))
  return Effect.succeed(value)
}

/** Every input a stage reads, as non-functional placeholders that never reach a provider. */
export const placeholders = (stage: string) => {
  const number = /^pr-(\d+)$/.exec(stage)?.[1]
  const github: ReadonlyArray<readonly [string, string]> =
    number === undefined
      ? []
      : [
          ["GITHUB_ACTIONS", "true"],
          ["GITHUB_SHA", "0123456789abcdef0123456789abcdef01234567"],
          ["GITHUB_REPOSITORY_OWNER", "Rika-Labs"],
          ["GITHUB_REPOSITORY", "Rika-Labs/akter"],
          ["PULL_REQUEST", number],
        ]
  return Object.fromEntries([
    ...github,
    ["FLY_API_TOKEN", "nonfunctional-offline-placeholder"],
    [
      "STRIPE_API_KEY",
      `sk_${stage === "prod" ? "live" : "test"}_nonfunctional-offline-placeholder`,
    ],
    ["VERCEL_TOKEN", "nonfunctional-offline-placeholder"],
    ["VERCEL_API_URL", "http://127.0.0.1:1"],
    ["RESEND_API_KEY", "nonfunctional-offline-placeholder"],
    ["AXIOM_TOKEN", "nonfunctional-offline-placeholder"],
    ["AXIOM_URL", "http://127.0.0.1:1"],
    ["AXIOM_NOTIFIER_ID", "placeholder"],
    ["PLANETSCALE_API_TOKEN_ID", "placeholder"],
    ["PLANETSCALE_API_TOKEN", "nonfunctional-offline-placeholder"],
    ["PLANETSCALE_ORGANIZATION", "placeholder"],
    ["PLANETSCALE_API_BASE_URL", "http://127.0.0.1:1"],
    ["NEKI_CLUSTER_SIZE", "PS_10"],
    ["NEKI_ROUTER_SIZE", "NKR_1"],
    ["IMAGE_TAG", "offline"],
  ])
}

/**
 * Compiles real declarations and providers with memory state; no planner or cloud lifecycle runs.
 * `declarations` holds the resolved props of the inspected types, with references to other
 * resources left symbolic.
 */
export const inspect = <A, StackErr>(input: {
  readonly stack: StackEffect<CompiledStack<A>, StackErr, Stage | AlchemyContext>
  readonly stage: string
  readonly environment: { readonly [name: string]: string }
}): Effect.Effect<Graph, StackErr | PlatformError, Layer.Success<typeof previewLayer>> =>
  Effect.suspend(() =>
    evalStack(
      input.stack,
      (compiled) =>
        Effect.gen(function* () {
          for (const resource of Object.values(compiled.resources)) {
            if ((yield* tryFindProviderByType(resource.Type)) === undefined)
              return yield* Effect.die(new Error(`No provider registered for ${resource.Type}`))
          }
          const upstream = Object.fromEntries(
            Object.entries(compiled.resources).map(([id, resource]) => [
              resource.FQN,
              symbolic(id),
            ]),
          )
          const declarations = Object.fromEntries(
            yield* Effect.forEach(
              Object.entries(compiled.resources).filter(([, resource]) =>
                inspectedTypes.has(resource.Type),
              ),
              ([id, resource]) =>
                Effect.map(settle(resource.Props, upstream), (props) => [id, props] as const),
            ),
          )
          return {
            stage: compiled.stage,
            name: compiled.name,
            resources: Object.entries(compiled.resources).map(([id, resource]) => ({
              id,
              type: resource.Type,
              removal: resource.RemovalPolicy,
            })),
            declarations,
          }
        }),
      { stage: input.stage },
    ).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(input.environment),
      ),
      Effect.provideService(AlchemyContext, {
        dotAlchemy: ".cache/alchemy-preview",
        dev: false,
        adopt: false,
      }),
      provideFreshArtifactStore,
    ),
  )

/** The service stack at `stage`, compiled with the stage's placeholders and any overrides. */
export const preview = (input: {
  readonly stage: string
  readonly overrides?: { readonly [name: string]: string }
}): Effect.Effect<Graph, ConfigError | PlatformError, Layer.Success<typeof previewLayer>> =>
  inspect({
    stack: Alchemy.Stack(
      stackName,
      { providers: stackProviders, state: inMemoryState() },
      resources,
    ),
    stage: input.stage,
    environment: { ...placeholders(input.stage), ...input.overrides },
  })

if (import.meta.main) {
  const runtime = ManagedRuntime.make(previewLayer)
  await runtime
    .runPromise(
      Effect.gen(function* () {
        for (const stage of ["prod", "preview", "pr-1"]) {
          const { name, resources } = yield* preview({ stage })
          yield* Console.log(
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              stage,
              name,
              resources,
            }),
          )
        }
      }),
    )
    .finally(() => runtime.dispose())
}
