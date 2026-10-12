import {
  Cause,
  Clock,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Stream,
} from "effect"
import type { Scope } from "effect"
import { RpcMiddleware } from "effect/rpc"
import { isUser } from "../contract/caller.ts"
import type { Anonymous, User } from "../contract/caller.ts"
import { ActorError, Reason, Unauthorized } from "../contract/errors.ts"
import type { AccessRequest, AnyActor } from "../contract/make.ts"
import { ErrorEnvelope } from "../rpc/group.ts"
import { reauthenticationDigest } from "./assertion/binding.ts"
import type { AuthProvider, AuthRequest, Authenticated } from "./auth.ts"
import { withinLimits } from "./auth.ts"

/**
 * One caller's binding to the transport: a WebSocket session, or one HTTP request. Every call
 * it carries runs as `caller`; `request` is the credential the next reauthorization reruns
 * `auth` on, and `deadline` is when the binding lapses unless a check succeeds first.
 */
export interface Session {
  readonly id: string
  readonly caller: User | Anonymous
  readonly tenant: string
  /** The upgrade or request path, which a reauthentication assertion binds. */
  readonly path: string
  /** The hosted session id the upgrade assertion carried, which every renewal must repeat. */
  readonly sid: string | undefined
  readonly ended: Deferred.Deferred<never, ActorError>
  /** The actors this session has called, which each reauthorization asks `access` about again. */
  readonly actors: Set<AnyActor>
  request: AuthRequest
  deadline: number
}

/** The session the current call runs in, provided by {@link Authorization}. */
export class CurrentSession extends Context.Service<CurrentSession, Session>()(
  "@rikalabs/akter/serve/session/CurrentSession",
) {}

/**
 * Binds every `/rpc` call to the session its transport authenticated: the HTTP request, or the
 * socket's upgrade. A call whose session ended, or lapsed past its reauthorization bound, is
 * refused before its handler runs.
 */
export class Authorization extends RpcMiddleware.Service<
  Authorization,
  { provides: CurrentSession }
>()("@rikalabs/akter/serve/session/Authorization", { error: ErrorEnvelope }) {}

/**
 * The header that carries a session id from the HTTP gate to {@link Authorization}. The gate
 * overwrites any value a client sent, and only the transport's own copy reaches the middleware.
 */
export const SESSION_HEADER = "x-akter-session"

const refused = (code: (typeof Unauthorized.Type)["code"]) =>
  ActorError.make({ reason: Unauthorized.make({ code }) })

const subjectOf = (caller: User | Anonymous) => (isUser(caller) ? caller.subject : undefined)

const sameCaller = (left: User | Anonymous, right: User | Anonymous) =>
  isUser(left) === isUser(right) && subjectOf(left) === subjectOf(right)

/** Runs an actor's `access` guard; a guard that throws refuses. */
const allows = (actor: AnyActor, caller: User | Anonymous, request: AccessRequest) => {
  try {
    return actor.access(caller, request)
  } catch {
    return false
  }
}

/** Whether an `auth` failure revokes the binding, as opposed to leaving it unconfirmed. */
const revokes = (cause: Cause.Cause<ActorError>) => {
  const error = Cause.findErrorOption(cause)
  return (
    Option.isSome(error) &&
    Reason.guards.Unauthorized(error.value.reason) &&
    error.value.reason.code !== "expired"
  )
}

/** The sessions of one server, and their reauthorization. */
export interface Sessions {
  /**
   * Registers a session for the scope's lifetime and starts its reauthorization: `auth` again
   * and `access` with kind `reauthorize` for every actor it called, within `reauthorizeEvery`
   * and never past the credential's own expiry. A refused check ends it with `access_denied`;
   * when no check succeeds within the bound it ends with `reauthorization_unavailable`.
   */
  readonly open: (options: {
    readonly id: string
    readonly authenticated: Authenticated
    readonly request: AuthRequest
    readonly path: string
  }) => Effect.Effect<Session, never, Scope.Scope>
  readonly find: (id: string) => Session | undefined
  /** Renews a session with a fresh credential for the same caller; `$reauthenticate`. */
  readonly reauthenticate: (
    session: Session,
    authorization: string,
  ) => Effect.Effect<void, ActorError>
}

const make = <R>(options: {
  readonly auth: AuthProvider<R>
  readonly reauthorizeEvery: Duration.Input
}): Effect.Effect<Sessions, never, R> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    const every = Duration.toMillis(Duration.fromInputUnsafe(options.reauthorizeEvery))
    const sessions = new Map<string, Session>()
    const authenticate = (request: AuthRequest) =>
      Effect.provideContext(options.auth.authenticate(request), context)

    const deadlineAfter = (now: number, authenticated: Authenticated) =>
      Math.min(
        now + every,
        authenticated.expiresAt === undefined
          ? Number.POSITIVE_INFINITY
          : DateTime.toEpochMillis(authenticated.expiresAt),
      )

    const end = (session: Session, code: (typeof Unauthorized.Type)["code"]) =>
      Deferred.fail(session.ended, refused(code))

    /** The access half of a check: every actor the session called must still admit its caller. */
    const stillAllowed = (session: Session) => {
      for (const actor of session.actors)
        if (!allows(actor, session.caller, { kind: "reauthorize", member: "reauthorize" }))
          return false
      return true
    }

    const check = (session: Session) =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(authenticate(session.request))
        const now = yield* Clock.currentTimeMillis
        if (Exit.isSuccess(result)) {
          const authenticated = result.value
          if (
            !withinLimits(authenticated) ||
            authenticated.tenant !== session.tenant ||
            !sameCaller(authenticated.caller, session.caller) ||
            !stillAllowed(session)
          )
            return yield* end(session, "access_denied")
          session.deadline = deadlineAfter(now, authenticated)
          return
        }
        if (revokes(result.cause)) return yield* end(session, "access_denied")
        if (now >= session.deadline) yield* end(session, "reauthorization_unavailable")
      })

    const reauthorize = (session: Session) =>
      Effect.gen(function* () {
        while (!(yield* Deferred.isDone(session.ended))) {
          const now = yield* Clock.currentTimeMillis
          yield* Effect.sleep(
            Duration.millis(Math.max(0, Math.min(every / 2, session.deadline - now))),
          )
          yield* check(session)
        }
      })

    const open: Sessions["open"] = ({ id, authenticated, request, path }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const session: Session = {
          id,
          caller: authenticated.caller,
          tenant: authenticated.tenant,
          path,
          sid: authenticated.binding?.session,
          ended: yield* Deferred.make<never, ActorError>(),
          actors: new Set(),
          request,
          deadline: deadlineAfter(now, authenticated),
        }
        sessions.set(id, session)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            sessions.delete(id)
          }),
        )
        yield* Effect.forkScoped(reauthorize(session))
        return session
      })

    const reauthenticate: Sessions["reauthenticate"] = (session, authorization) =>
      Effect.gen(function* () {
        const request: AuthRequest = {
          headers: session.request.headers,
          cookies: session.request.cookies,
          credential: authorization,
        }
        const authenticated = yield* authenticate(request)
        const binding = authenticated.binding
        if (binding !== undefined) {
          const expected =
            session.sid === undefined
              ? undefined
              : yield* reauthenticationDigest({ path: session.path, session: session.sid })
          if (binding.session !== session.sid || binding.request !== expected)
            return yield* refused("invalid_credentials")
        }
        if (
          !withinLimits(authenticated) ||
          authenticated.tenant !== session.tenant ||
          !sameCaller(authenticated.caller, session.caller) ||
          !stillAllowed(session)
        ) {
          yield* end(session, "access_denied")
          return yield* refused("access_denied")
        }
        session.request = request
        session.deadline = deadlineAfter(yield* Clock.currentTimeMillis, authenticated)
      })

    return { open, find: (id) => sessions.get(id), reauthenticate }
  })

/**
 * The {@link Authorization} middleware over a server's sessions. It refuses a call whose session
 * is unknown, ended or past its bound, and otherwise provides the session to the handler.
 */
const middleware = (sessions: Sessions) =>
  Authorization.of((effect, { headers }) =>
    Effect.gen(function* () {
      const id = headers[SESSION_HEADER]
      const session = id === undefined ? undefined : sessions.find(id)
      if (session === undefined) return yield* refused("missing_credentials")
      const ended = yield* Deferred.poll(session.ended)
      if (Option.isSome(ended)) return yield* ended.value
      if ((yield* Clock.currentTimeMillis) >= session.deadline) {
        yield* Deferred.fail(session.ended, refused("reauthorization_unavailable"))
        return yield* refused("reauthorization_unavailable")
      }
      return yield* Effect.provideService(effect, CurrentSession, session)
    }),
  )

/** Ends `effect` with the session's error as soon as the session ends. */
const guard = <A, E, R>(session: Session, effect: Effect.Effect<A, E, R>) =>
  Effect.raceFirst(effect, Deferred.await(session.ended))

/** Ends `stream` with the session's error as soon as the session ends; queued values are dropped. */
const guardStream = <A, E, R>(session: Session, stream: Stream.Stream<A, E, R>) =>
  Stream.interruptWhen(stream, Deferred.await(session.ended))

/** A server's sessions, the middleware that binds calls to them, and the guards on their calls. */
export const Sessions = { make, middleware, guard, guardStream }
