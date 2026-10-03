import {
  CloudApi,
  Conflict,
  type EnvironmentName,
  type Project,
  type SeriesWindow,
} from "@akter/cloud-api"
import { Context, Crypto, Effect, Function, Layer, ManagedRuntime, Predicate, Schema } from "effect"
import { BrowserCrypto } from "@effect/platform-browser"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"

/** The public API mount; the contract already owns its `/api` prefix. */
export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api"

/** Resolves the contract prefix once, including browser-relative configuration. */
export const apiOrigin: {
  (base: string, origin: string): string
  (origin: string): (base: string) => string
} = Function.dual(2, (base: string, origin: string): string =>
  new URL(base.replace(/\/$/, "").replace(/\/api$/, "") || "/", origin).href.replace(/\/$/, ""),
)

/** Fixture mode is explicit and survives client-side navigation through session storage. */
export const fixturesEnabled = (): boolean => {
  if (import.meta.env.VITE_CONSOLE_FIXTURES === "1") return true
  if (!import.meta.env.DEV) return false
  if (typeof window === "undefined") return false
  const flag = new URLSearchParams(window.location.search).get("fixtures")
  try {
    if (flag !== null) window.sessionStorage.setItem("console-fixtures", flag === "1" ? "1" : "0")
    return window.sessionStorage.getItem("console-fixtures") === "1"
  } catch {
    return flag === "1"
  }
}

/** One cookie-bearing, schema-derived client for every console route. */
export class CloudClient extends Context.Service<
  CloudClient,
  HttpApiClient.ForApi<typeof CloudApi>
>()("@akter/console/app/api/client/CloudClient") {}

const layer = Layer.effect(
  CloudClient,
  Effect.suspend(() =>
    HttpApiClient.make(CloudApi, {
      baseUrl: apiOrigin(
        apiBaseUrl,
        typeof location === "undefined" ? "http://localhost" : location.origin,
      ),
    }),
  ),
).pipe(
  Layer.provide(
    FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" })),
    ),
  ),
)

const runtime = ManagedRuntime.make(layer)
export const cloud = Effect.promise(() => runtime.runPromise(CloudClient))
const identifiers = ManagedRuntime.make(BrowserCrypto.layer)

/** A fresh receipt key is minted once per opened send dialog so retries can reuse it safely. */
export const newCommandId = Effect.tryPromise({
  try: () => identifiers.runPromise(Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4)),
  catch: (cause) => consoleError(cause),
})

/** Errors cross the FoldKit command boundary as readable states, never unchecked defects. */
export class ConsoleError extends Schema.TaggedError<ConsoleError>()("ConsoleError", {
  kind: Schema.String,
  message: Schema.String,
}) {}

/** Preserves contract error categories while keeping transport details out of the UI. */
export const consoleError = (cause: unknown): ConsoleError => {
  if (Schema.is(ConsoleError)(cause)) return cause
  if (Predicate.isTagged(cause, "Unauthorized")) {
    return ConsoleError.make({ kind: "Unauthorized", message: "Sign in to continue." })
  }
  if (Predicate.isTagged(cause, "Forbidden"))
    return ConsoleError.make({
      kind: "Forbidden",
      message: "You don’t have permission to view or change this.",
    })
  if (Predicate.isTagged(cause, "NotFound"))
    return ConsoleError.make({ kind: "NotFound", message: "This resource is no longer available." })
  if (Schema.is(Conflict)(cause))
    return ConsoleError.make({ kind: "Conflict", message: cause.message })
  if (Predicate.isTagged(cause, "NotImplemented"))
    return ConsoleError.make({
      kind: "NotImplemented",
      message: "This action isn’t available yet.",
    })
  return ConsoleError.make({
    kind: "Unavailable",
    message: "We couldn’t reach Akter. Please try again.",
  })
}

/** The source travels with the data so sample rows cannot acquire live actions. */
export interface Loaded<A> {
  readonly data: A
  readonly sample: boolean
}

/** A fixture is imported only when explicitly requested or its endpoint answers `NotImplemented`. */
export const load: {
  <A, E>(
    live: Effect.Effect<A, E>,
    fixture: () => Promise<A>,
  ): Effect.Effect<Loaded<A>, ConsoleError>
  <A>(
    fixture: () => Promise<A>,
  ): <E>(live: Effect.Effect<A, E>) => Effect.Effect<Loaded<A>, ConsoleError>
} = Function.dual(
  2,
  <A, E>(
    live: Effect.Effect<A, E>,
    fixture: () => Promise<A>,
  ): Effect.Effect<Loaded<A>, ConsoleError> => {
    const fallback = Effect.tryPromise({ try: fixture, catch: consoleError }).pipe(
      Effect.map((data) => ({ data, sample: true })),
    )
    return Effect.suspend(() =>
      fixturesEnabled()
        ? fallback
        : live.pipe(
            Effect.map((data) => ({ data, sample: false })),
            Effect.catch((error) =>
              Predicate.isTagged(error, "NotImplemented")
                ? fallback
                : Effect.fail(consoleError(error)),
            ),
          ),
    )
  },
)

/** The active membership is server-authoritative, with the first membership as the initial choice. */
export const organizationContext = Effect.gen(function* () {
  const api = yield* cloud
  const me = yield* api.account.me()
  const membership =
    me.organizations.find((item) => item.organization.id === me.activeOrganizationId) ??
    me.organizations[0]
  if (membership === undefined)
    return yield* ConsoleError.make({
      kind: "Onboarding",
      message: "Create an organization to get started.",
    })
  return membership
}).pipe(Effect.mapError(consoleError))

/** Only contract environments can be used in an API path. */
export const selectedEnvironment = (): EnvironmentName => {
  const selected = storedChoice("console-environment")
  return selected === "staging" || selected === "dev" ? selected : "production"
}

/** Only the contract's windows can be used to request runtime series. */
export const selectedWindow = (): SeriesWindow => {
  const window = storedChoice("console-series-window")
  return window === "1h" || window === "7d" ? window : "24h"
}

const storedChoice = (key: string): string | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(key)
  } catch {
    return null
  }
}

/** Keeps a protected invitation or page reachable after the session gate asks for sign-in. */
export const rememberAuthReturn = (): void => {
  try {
    if (typeof location !== "undefined" && typeof sessionStorage !== "undefined")
      sessionStorage.setItem("console-auth-return", `${location.pathname}${location.search}`)
  } catch {
    return
  }
}

/** Resolves an internal return path without consuming it before an authentication attempt succeeds. */
export const peekSignInDestination = (fallback: string): string => {
  const stored = storedChoice("console-auth-return")
  if (stored === null || typeof location === "undefined") return fallback
  try {
    const target = new URL(stored, location.origin)
    if (
      target.origin !== location.origin ||
      !stored.startsWith("/") ||
      /^\/(sign-in|sign-up|forgot-password|reset-password|verify-email)(?:[/?]|$)/.test(
        target.pathname,
      )
    )
      return fallback
    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return fallback
  }
}

/** Consumes the remembered destination only after successful authentication. */
export const signInDestination = (fallback: string): string => {
  const destination = peekSignInDestination(fallback)
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem("console-auth-return")
  } catch {
    return fallback
  }
  return destination
}

const rememberProject = (slug: string): void => {
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem("console-project", slug)
  } catch {
    return
  }
}

/** Resolves the selected project slug to its branded ID; it never treats a display slug as an ID. */
export const projectContext = Effect.gen(function* () {
  const api = yield* cloud
  const { organization } = yield* organizationContext
  const projects = yield* api.projects.list({ params: { organizationId: organization.id } })
  const pathname = typeof location === "undefined" ? "/" : location.pathname
  const encodedSlug = /^\/projects\/([^/]+)/.exec(pathname)?.[1]
  const routeSlug = yield* Effect.try({
    try: () => (encodedSlug === undefined ? undefined : decodeURIComponent(encodedSlug)),
    catch: () => ConsoleError.make({ kind: "NotFound", message: "This project link is invalid." }),
  })
  if (routeSlug !== undefined) rememberProject(routeSlug)
  const selected = routeSlug ?? storedChoice("console-project")
  const project: Project | undefined =
    projects.find((item) => item.slug === selected) ??
    (routeSlug === undefined ? projects[0] : undefined)
  if (project === undefined)
    return yield* ConsoleError.make({
      kind: "NotFound",
      message: "Choose or create a project to continue.",
    })
  return { project, environment: selectedEnvironment(), organizationId: organization.id }
}).pipe(Effect.mapError(consoleError))

/** Project identity must resolve before an endpoint may fall back to sample data. */
export const withProject: {
  <A, E>(
    run: (
      api: HttpApiClient.ForApi<typeof CloudApi>,
      context: Effect.Success<typeof projectContext>,
    ) => Effect.Effect<A, E>,
    fixture: () => Promise<A>,
  ): Effect.Effect<Loaded<A>, ConsoleError>
  <A>(
    fixture: () => Promise<A>,
  ): <E>(
    run: (
      api: HttpApiClient.ForApi<typeof CloudApi>,
      context: Effect.Success<typeof projectContext>,
    ) => Effect.Effect<A, E>,
  ) => Effect.Effect<Loaded<A>, ConsoleError>
} = Function.dual(
  2,
  <A, E>(
    run: (
      api: HttpApiClient.ForApi<typeof CloudApi>,
      context: Effect.Success<typeof projectContext>,
    ) => Effect.Effect<A, E>,
    fixture: () => Promise<A>,
  ) =>
    Effect.suspend(() =>
      fixturesEnabled()
        ? load(
            Effect.fail(
              ConsoleError.make({ kind: "Sample", message: "Sample data is read-only." }),
            ),
            fixture,
          )
        : Effect.gen(function* () {
            const api = yield* cloud
            const context = yield* projectContext
            return yield* load(run(api, context), fixture)
          }),
    ),
)
