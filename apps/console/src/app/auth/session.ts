import { type BetterFetchOption, createAuthClient } from "better-auth/client"
import { Effect, Option, Schema } from "effect"
import { AppRoute } from "../navigation/routes.ts"
import {
  apiBaseUrl,
  apiOrigin,
  ConsoleError,
  fixturesEnabled,
  peekSignInDestination,
  signInDestination,
} from "../api/client.ts"

/** Better Auth's mount, a sibling of the API prefix on the same origin. */
export const authBasePath = "/auth"

/** The signed-in person as the session answers it. */
export type SessionUser = Readonly<{
  id: string
  name: string
  email: string
  emailVerified: boolean
}>

/** The wire options of the Better Auth client; `fetch` replaces the network. */
export interface AuthClientOptions {
  readonly origin?: string
  readonly fetch?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>
}

/** A Better Auth browser client for cookie sessions under `/auth`. */
export const makeAuthClient = (options: AuthClientOptions = {}) => {
  const fetchOptions: BetterFetchOption = { credentials: "include" }
  if (options.fetch !== undefined) fetchOptions.customFetchImpl = options.fetch
  return createAuthClient({
    baseURL: `${apiOrigin(apiBaseUrl, options.origin ?? location.origin)}${authBasePath}`,
    fetchOptions,
  })
}

/** A Better Auth client. */
export type AuthClient = ReturnType<typeof makeAuthClient>

interface Failure {
  readonly status: number
  readonly message?: string | undefined
  readonly code?: string | undefined
}

const messages = new Map([
  ["INVALID_EMAIL_OR_PASSWORD", "That email and password don’t match an account."],
  ["EMAIL_NOT_VERIFIED", "Verify your email address first."],
  ["USER_ALREADY_EXISTS", "An account with that email already exists."],
  ["USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", "An account with that email already exists."],
  ["PASSWORD_TOO_SHORT", "Use a longer password."],
  ["PASSWORD_TOO_LONG", "Use a shorter password."],
  ["INVALID_TOKEN", "This link is invalid or has expired. Request a new one."],
  ["INVALID_EMAIL", "Enter a valid email address."],
])

/** Turns a Better Auth failure into the console's readable error, keeping its code as the kind. */
export const authError = (failure: Failure): ConsoleError => {
  const kind = failure.code ?? `Http${String(failure.status)}`
  const known = failure.code === undefined ? undefined : messages.get(failure.code)
  if (known !== undefined) return ConsoleError.make({ kind, message: known })
  if (failure.status === 429)
    return ConsoleError.make({ kind, message: "Too many attempts. Try again in a minute." })
  if (
    failure.status >= 400 &&
    failure.status < 500 &&
    failure.message !== undefined &&
    failure.message !== ""
  )
    return ConsoleError.make({ kind, message: failure.message })
  return ConsoleError.make({ kind, message: "We couldn’t reach Akter. Please try again." })
}

const unreachable = ConsoleError.make({
  kind: "Unavailable",
  message: "We couldn’t reach Akter. Please try again.",
})

type Answer<A> = Promise<
  { readonly data: A; readonly error: null } | { readonly data: null; readonly error: Failure }
>

const SessionAnswer = Schema.NullOr(
  Schema.Struct({
    user: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      email: Schema.String,
      emailVerified: Schema.Boolean,
    }),
  }),
)

const SignedInAnswer = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) })
const SignedUpAnswer = Schema.Struct({ user: Schema.Struct({ emailVerified: Schema.Boolean }) })
const SocialAnswer = Schema.Struct({ url: Schema.String })
const StatusAnswer = Schema.Struct({ status: Schema.Literal(true) })
const SuccessAnswer = Schema.Struct({ success: Schema.Literal(true) })

/**
 * The Better Auth calls the console makes, as Effects that fail with `ConsoleError`. The client is
 * read per call so nothing touches `location` until a call runs. Links in emails and provider
 * redirects point back at the console's own `origin`, which can differ from the API host. Every
 * answer is decoded against the shape the console reads, because a host that serves its app shell
 * for `/auth` answers 200 with HTML and the client's types say nothing about that.
 */
export const makeAuth = (input: Readonly<{ client: () => AuthClient; origin?: () => string }>) => {
  const { client } = input
  const origin = input.origin ?? (() => location.origin)
  const answered = <A, I>(
    answer: Schema.Codec<A, I>,
    run: (client: AuthClient) => Answer<unknown>,
  ): Effect.Effect<A, ConsoleError> =>
    Effect.tryPromise({ try: () => run(client()), catch: () => unreachable }).pipe(
      Effect.flatMap((answer) =>
        answer.error === null ? Effect.succeed(answer.data) : Effect.fail(authError(answer.error)),
      ),
      Effect.flatMap((data) =>
        Schema.decodeUnknownEffect(answer)(data).pipe(Effect.mapError(() => unreachable)),
      ),
    )

  return {
    session: answered(SessionAnswer, (auth) => auth.getSession()).pipe(
      Effect.map((data) =>
        Option.fromNullishOr(data).pipe(Option.map(({ user }): SessionUser => ({ ...user }))),
      ),
    ),
    signInEmail: (input: Readonly<{ email: string; password: string }>) =>
      answered(SignedInAnswer, (auth) => auth.signIn.email(input)),
    signUpEmail: (input: Readonly<{ name: string; email: string; password: string }>) =>
      answered(SignedUpAnswer, (auth) =>
        auth.signUp.email({
          ...input,
          callbackURL: `${origin()}${peekSignInDestination("/onboarding")}`,
        }),
      ).pipe(Effect.tap(() => Effect.sync(() => signInDestination("/onboarding")))),
    signInSocial: (provider: "github" | "google") =>
      answered(SocialAnswer, (auth) =>
        auth.signIn.social({
          provider,
          callbackURL: `${origin()}${peekSignInDestination("/")}`,
          newUserCallbackURL: `${origin()}/onboarding`,
          errorCallbackURL: `${origin()}/sign-in`,
          disableRedirect: true,
        }),
      ).pipe(
        Effect.tap(() => Effect.sync(() => signInDestination("/"))),
        Effect.map(({ url }) => url),
      ),
    signOut: answered(SuccessAnswer, (auth) => auth.signOut()),
    sendVerificationEmail: (email: string) =>
      answered(StatusAnswer, (auth) =>
        auth.sendVerificationEmail({ email, callbackURL: `${origin()}/onboarding` }),
      ),
    requestPasswordReset: (email: string) =>
      answered(StatusAnswer, (auth) =>
        auth.requestPasswordReset({ email, redirectTo: `${origin()}/reset-password` }),
      ),
    resetPassword: (input: Readonly<{ newPassword: string; token: string }>) =>
      answered(StatusAnswer, (auth) => auth.resetPassword(input)),
  }
}

let shared: AuthClient | undefined

/** The console's Better Auth calls against the page's origin. */
export const auth = makeAuth({ client: () => (shared ??= makeAuthClient()) })

/** Where a route sends the visitor: stay, to sign in, or past the auth screens. */
export type Access = "allow" | "sign-in" | "overview"

/**
 * The session rule for a route. Sign-in, sign-up and forgot-password are for signed-out visitors,
 * the verify screen for people whose address is not yet verified, and the reset and not-found
 * pages for anyone; every other page needs a session.
 */
export const accessFor = (
  input: Readonly<{ route: AppRoute; session: Option.Option<SessionUser> }>,
): Access => {
  const { route, session } = input
  if (AppRoute.isAnyOf(["ResetPassword", "NotFound"])(route)) return "allow"
  if (AppRoute.isAnyOf(["SignIn", "SignUp", "ForgotPassword"])(route))
    return Option.isSome(session) ? "overview" : "allow"
  if (AppRoute.isAnyOf(["VerifyEmail"])(route))
    return Option.exists(session, (user) => user.emailVerified) ? "overview" : "allow"
  return Option.isSome(session) ? "allow" : "sign-in"
}

/**
 * Reads the session and fails with `Unauthorized` or `SignedIn` when the route belongs elsewhere;
 * the shell turns either into a redirect. Pages open to everyone skip the call, a session that
 * cannot be read counts as signed out, and fixture mode never calls the service. `allowSignIn`
 * keeps the sign-in screen open for a visitor whose session the API just refused, since sending
 * them back to the overview would loop. Remembering the return path is the caller's job, so the
 * guard itself reads and decides only.
 */
export const guardRoute = (
  input: Readonly<{
    route: AppRoute
    allowSignIn?: boolean
    read?: Effect.Effect<Option.Option<SessionUser>, ConsoleError>
  }>,
): Effect.Effect<void, ConsoleError> =>
  Effect.suspend(() => {
    const { route, allowSignIn = false, read = auth.session } = input
    if (fixturesEnabled() || AppRoute.isAnyOf(["ResetPassword", "NotFound"])(route))
      return Effect.void
    if (allowSignIn && AppRoute.isAnyOf(["SignIn"])(route)) return Effect.void
    return read.pipe(
      Effect.orElseSucceed(() => Option.none<SessionUser>()),
      Effect.flatMap((session) => {
        const access = accessFor({ route, session })
        if (access === "allow") return Effect.void
        return Effect.fail(
          access === "sign-in"
            ? ConsoleError.make({ kind: "Unauthorized", message: "Sign in to continue." })
            : ConsoleError.make({ kind: "SignedIn", message: "You are already signed in." }),
        )
      }),
    )
  })
