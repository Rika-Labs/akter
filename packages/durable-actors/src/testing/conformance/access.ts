import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import {
  Cause,
  Context,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  Queue,
  Redacted,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from "effect"
import {
  Actor,
  ActorError,
  Anonymous,
  Content,
  type ContentStore,
  CurrentCaller,
  System,
  User,
  type Access,
  type AccessRequest,
  Caller,
} from "../../index.ts"
import { Actors as PublicActors } from "../../handles/actors.ts"
import { InternalActors } from "../../runtime/actors.ts"
import { Outcome, Request } from "../../runtime/request.ts"
import {
  Actors,
  Database,
  Inspector,
  OperatorAuth,
  Operators,
  Telemetry,
} from "../../runtime/index.ts"
import type { RuntimeControl } from "../../runtime/drain.ts"
import type { OperatorRuntime } from "../../runtime/operators/repair.ts"
import type { DefectLog } from "../../runtime/telemetry/defects.ts"
import { SUBPROTOCOL } from "../../protocol/frames.ts"
import { MCP_VERSION } from "../../serve/mcp/endpoint.ts"
import { openFeed } from "../../serve/sessions/feed.ts"
import { ActorTest, executeForTest, TEST_CONTENT_KEY } from "../actor-test.ts"
import type {
  ConformanceCase,
  ConformanceDatabase,
  ConformanceEnvironment,
} from "../conformance.ts"
import { serveHttp } from "./http.ts"

class Posted extends Actor.Event<Posted>()("AccessPosted", { amount: Schema.Finite }) {}

class Ping extends Schema.TaggedClass<Ping>()("AccessPing", {}) {}

const Post = Actor.command("Post", { input: Schema.Finite, output: Schema.Finite })

const Whoami = Actor.command("Whoami", { output: Schema.String })

const Seal = Actor.command("Seal", { output: Schema.String })

const Balance = Actor.query("Balance", { output: Schema.Finite })

const Watch = Actor.connection("Watch", { server: Ping })

const Ticks = Actor.stream("Ticks", { output: Schema.Finite })

const Files = Actor.content("files")

const subjectOf = (caller: Caller) =>
  Caller.match(caller, {
    User: ({ subject }) => subject,
    Anonymous: () => "",
    System: ({ source }) => source,
  })

const isUser = Schema.is(User)

const isSystem = Schema.is(System)

const isAnonymous = Schema.is(Anonymous)

/**
 * An actor type named `name` that declares `access` when given. `Whoami`
 * answers the tenant and caller the turn ran as, so a case reads what the
 * runtime attributed; the connection, stream, feed, and content members give
 * every kind of request something to ask about.
 */
const ledgerOf = (name: string, access?: Access) => {
  const Ledger = Actor.make(name, {
    key: Schema.String,
    state: Actor.state({
      balance: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    }),
    events: [Posted],
    feeds: [Posted],
    blobs: [Files],
    api: { Post, Whoami, Balance, Watch, Ticks },
    internal: { Seal },
    policy: { reauthorizeEvery: "1 second" },
    access,
  })

  const layer = Layer.mergeAll(
    Ledger.toLayer(
      Effect.succeed({
        Post: Effect.fnUntraced(function* (amount: number) {
          const turn = yield* Ledger.Turn
          yield* turn.state.set({ balance: turn.state.balance + amount })
          yield* turn.emit(Posted.make({ amount }))

          return turn.state.balance
        }),
        Whoami: Effect.fnUntraced(function* () {
          const { caller, ref } = yield* Ledger.Turn

          return `${ref.tenant}/${caller._tag}/${subjectOf(caller)}`
        }),
        Seal: () => Effect.succeed("sealed"),
        Watch: { open: () => Effect.void, frame: () => Effect.void },
        Ticks: () => Stream.fromSchedule(Schedule.spaced("100 millis")),
      }),
    ),
    Ledger.toQueryLayer(
      Effect.succeed({
        Balance: Effect.fnUntraced(function* () {
          return (yield* Ledger.Read).state.balance
        }),
      }),
    ),
  )

  return { Ledger, layer }
}

type Services =
  | DefectLog
  | OperatorRuntime
  | SqlClient.SqlClient
  | PublicActors
  | InternalActors
  | RuntimeControl
  | ActorTest
  | ContentStore
  | Crypto.Crypto
  | Scope.Scope

interface Wiring {
  readonly authorize?: (request: AccessRequest) => Effect.Effect<boolean>
}

/** Runs `body` on a fresh database and an `ActorTest` runtime serving `actors`, then stops the runtime. */
const deploy = <A, E>(
  environment: ConformanceEnvironment,
  actors: Layer.Layer<never, never, InternalActors>,
  wiring: Wiring,
  body: Effect.Effect<A, E, Services>,
) =>
  environment.run(
    Effect.gen(function* () {
      const database = yield* environment.freshDatabase
      const crypto = yield* Crypto.Crypto

      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() =>
          ManagedRuntime.make(
            actors.pipe(
              Layer.provideMerge(ActorTest.layer({ database, ...wiring })),
              Layer.provideMerge(Layer.succeed(Crypto.Crypto, crypto)),
              Layer.orDie,
            ),
          ),
        ),
        (runtime) => Effect.promise(() => runtime.dispose()),
      )

      return yield* Effect.promise(() => runtime.runPromiseExit(Effect.scoped(body))).pipe(
        Effect.flatten,
      )
    }).pipe(Effect.orDie),
  )

const databaseLayer = (database: ConformanceDatabase) =>
  Redacted.isRedacted(database)
    ? Database.postgres({ url: database, maxConnections: 4 })
    : Database.pglite(database)

const isDenied = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return false

  const failure = Cause.findErrorOption(exit.cause)

  return (
    Option.isSome(failure) &&
    Schema.is(ActorError)(failure.value) &&
    Predicate.isTagged(failure.value.reason, "Unauthorized") &&
    failure.value.reason.code === "access_denied"
  )
}

/** How a request ended: `allowed`, refused with `access_denied`, or `failed` for anything else. */
const outcomeOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => (Exit.isSuccess(exit) ? "allowed" : isDenied(exit) ? "denied" : "failed")),
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () => Effect.die(new Error("A request never answered")),
    }),
  )

const KINDS = ["command", "query", "open", "stream", "feed", "content"] as const

type Kind = (typeof KINDS)[number]

const alice = User.make({ subject: "alice" })

const bob = User.make({ subject: "bob" })

/** One request of each kind against the actor `id` of `Ledger`, as whoever is the ambient caller. */
const requestsOf = (Ledger: ReturnType<typeof ledgerOf>["Ledger"], id: string) => {
  const requests: Record<Kind, Effect.Effect<unknown, ActorError, Services>> = {
    command: Effect.flatMap(Ledger.get(id), (ledger) => ledger.Post(1)),
    query: Effect.flatMap(Ledger.get(id), (ledger) => ledger.Balance()),
    open: Effect.gen(function* () {
      const test = yield* ActorTest
      const { ref } = yield* Ledger.get(id)
      const connection = yield* test.connect(ref, Watch, undefined)
      yield* connection.close
    }),
    stream: Effect.flatMap(Ledger.get(id), (ledger) =>
      ledger.Ticks().pipe(Stream.take(1), Stream.runCollect),
    ),
    feed: Effect.gen(function* () {
      const { ref } = yield* Ledger.get(id)

      const held = yield* openFeed({
        actors: yield* InternalActors,
        ref,
        tags: [Posted.identifier],
        caller: yield* CurrentCaller,
        expiresAt: undefined,
      })

      yield* held.close
    }),
    content: Content.grant(Ledger, id, Files, "file"),
  }

  return requests
}

const outcomes = (
  requests: Record<Kind, Effect.Effect<unknown, ActorError, Services>>,
  caller?: Caller,
  only?: Kind,
) =>
  Effect.gen(function* () {
    const found: Partial<Record<Kind, string>> = {}

    for (const kind of only === undefined ? KINDS : [only])
      found[kind] = yield* outcomeOf(
        caller === undefined ? requests[kind] : requests[kind].pipe(Actor.as(caller)),
      )

    return found
  })

const everyKind = (outcome: string) => Object.fromEntries(KINDS.map((kind) => [kind, outcome]))

const MCP_VERSION_HEADERS = {
  "content-type": "application/json",
  "mcp-protocol-version": MCP_VERSION,
  "mcp-method": "tools/call",
}

/** A served reply: its status and body text. */
interface Reply {
  readonly status: number
  readonly text: string
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const decodeMinted = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ commandId: Schema.String })),
)

/** Sends one request to the served app and reads its whole body, which a revoked session ends. */
const fetchText = (
  url: string,
  init?: {
    readonly method?: "GET" | "POST"
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: unknown
  },
) =>
  Effect.gen(function* () {
    const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient)

    const base = HttpClientRequest.make(init?.method ?? "GET")(url, {
      headers: init?.headers ?? {},
    })

    const request =
      init?.body === undefined
        ? base
        : HttpClientRequest.bodyText(
            base,
            yield* encodeJson(init.body).pipe(Effect.orDie),
            "application/json",
          )

    const response = yield* client.execute(request)

    return { status: response.status, text: yield* response.text } satisfies Reply
  }).pipe(
    Effect.orDie,
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.die(new Error(`${url} never finished`)),
    }),
  )

/** Opens a WebSocket to a connection route, says hello, and collects messages until the session ends. */
const socketMessages = (url: string) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<string>()
    const closed = yield* Deferred.make<void>()
    const ws = new WebSocket(url, SUBPROTOCOL)

    ws.onopen = () => ws.send('{"t":"hello"}')
    ws.onmessage = (event) => Queue.offerUnsafe(received, String(event.data))
    ws.onclose = () => Deferred.doneUnsafe(closed, Effect.void)

    yield* Deferred.await(closed).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.die(new Error(`${url} never closed`)),
      }),
      Effect.ensuring(Effect.sync(() => ws.close())),
    )

    return (yield* Queue.clear(received)).join("\n")
  })

const deniedReply = (reply: Reply) => reply.status === 403 || reply.text.includes("access_denied")

/** Cases for the default caller and tenant, actor `access` policies, and the global `authorize` hook they combine with. */
export const accessConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "runs in-process code as System({ source: process }) in the default tenant, with no authorize and no Actor.as or Actor.tenant",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          const crypto = yield* Crypto.Crypto
          const { Ledger, layer } = ledgerOf("AccessProcess")

          const runtime = yield* Effect.acquireRelease(
            Effect.sync(() =>
              ManagedRuntime.make(
                layer.pipe(
                  Layer.provideMerge(Actors.layer({ content: { keys: [TEST_CONTENT_KEY] } })),
                  Layer.provideMerge(databaseLayer(database)),
                  Layer.provideMerge(Layer.succeed(Crypto.Crypto, crypto)),
                  Layer.orDie,
                ),
              ),
            ),
            (runtime) => Effect.promise(() => runtime.dispose()),
          )

          const answered = yield* Effect.promise(() =>
            runtime.runPromise(
              Effect.gen(function* () {
                const handle = yield* Ledger.get("process")

                return {
                  tenant: handle.ref.tenant,
                  who: yield* handle.Whoami(),
                  balance: yield* handle.Post(3),
                  read: yield* handle.Balance(),
                }
              }),
            ),
          )

          expect(answered).toEqual({
            tenant: "default",
            who: "default/System/process",
            balance: 3,
            read: 3,
          })

          const asUser = yield* Effect.promise(() =>
            runtime.runPromiseExit(
              Effect.flatMap(Ledger.get("process"), (handle) => handle.Post(1)).pipe(
                Actor.as(alice),
              ),
            ),
          )

          expect(isDenied(asUser)).toBe(true)
        }),
      ),
  },
  {
    name: "allows System callers and denies User and Anonymous callers of every kind when there is no access and no authorize",
    run: ({ expect, environment }) => {
      const { Ledger, layer } = ledgerOf("AccessClosed")

      return deploy(
        environment,
        layer,
        {},
        Effect.gen(function* () {
          const requests = requestsOf(Ledger, "closed")

          yield* requests.command
          expect(yield* outcomes(requests)).toEqual(everyKind("allowed"))
          expect(yield* outcomes(requests, System.make({ source: "cron" }))).toEqual(
            everyKind("allowed"),
          )
          expect(yield* outcomes(requests, alice)).toEqual(everyKind("denied"))
          expect(yield* outcomes(requests, Anonymous.make({}))).toEqual(everyKind("denied"))
        }),
      )
    },
  },
  {
    name: "asks an actor's access policy for each kind: command, query, open, stream, feed, and content each allow and deny on their own",
    run: ({ expect, environment }) => {
      let selected: Kind = "command"
      const seen: Array<AccessRequest> = []

      const { Ledger, layer } = ledgerOf("AccessKinds", (request) => {
        seen.push(request)

        return (
          isSystem(request.caller) ||
          (isUser(request.caller) &&
            request.caller.subject === "alice" &&
            request.kind === selected)
        )
      })

      return deploy(
        environment,
        layer,
        {},
        Effect.gen(function* () {
          const requests = requestsOf(Ledger, "kinds")

          yield* requests.command
          expect(yield* outcomes(requests)).toEqual(everyKind("allowed"))

          for (const kind of KINDS) {
            selected = kind

            expect(yield* outcomes(requests, alice)).toEqual(
              Object.fromEntries(
                KINDS.map((other) => [other, other === kind ? "allowed" : "denied"]),
              ),
            )
            expect(yield* outcomes(requests, bob, kind)).toEqual({ [kind]: "denied" })
            expect(yield* outcomes(requests, Anonymous.make({}), kind)).toEqual({
              [kind]: "denied",
            })
          }

          const asked = seen.filter(({ caller }) => isUser(caller) && caller.subject === "alice")

          for (const kind of KINDS)
            expect(asked.some((request) => request.kind === kind)).toBe(true)

          expect(asked.find(({ kind }) => kind === "command")).toMatchObject({
            caller: alice,
            ref: { actor: "AccessKinds", id: "kinds" },
            command: "Post",
          })
          expect(asked.find(({ kind }) => kind === "feed")).toMatchObject({
            command: Posted.identifier,
          })
          expect(asked.find(({ kind }) => kind === "content")).toMatchObject({
            command: "files.grant",
          })
        }),
      )
    },
  },
  {
    name: "requires the global authorize and the actor's access to both allow, and lets either alone decide when the other is absent",
    run: ({ expect, environment }) => {
      let globalAllows = true
      let actorAllows = true
      const globalSeen: Array<AccessRequest> = []
      const actorSeen: Array<AccessRequest> = []

      const guarded = ledgerOf("AccessGuarded", (request) => {
        actorSeen.push(request)

        return actorAllows
      })

      const bare = ledgerOf("AccessBare")

      return deploy(
        environment,
        Layer.merge(guarded.layer, bare.layer),
        {
          authorize: (request) =>
            Effect.sync(() => {
              globalSeen.push(request)

              return globalAllows
            }),
        },
        Effect.gen(function* () {
          const post = (ledger: typeof guarded.Ledger, id: string) =>
            outcomeOf(
              Effect.flatMap(ledger.get(id), (handle) => handle.Post(1)).pipe(Actor.as(alice)),
            )

          const answers: Array<readonly [boolean, boolean, string]> = []

          for (const [global, actor] of [
            [true, true],
            [true, false],
            [false, true],
            [false, false],
          ] as const) {
            globalAllows = global
            actorAllows = actor
            answers.push([global, actor, yield* post(guarded.Ledger, "both")])
          }

          expect(answers).toEqual([
            [true, true, "allowed"],
            [true, false, "denied"],
            [false, true, "denied"],
            [false, false, "denied"],
          ])

          actorAllows = false
          globalAllows = true
          expect(yield* post(bare.Ledger, "authorize-alone")).toBe("allowed")
          globalAllows = false
          expect(yield* post(bare.Ledger, "authorize-alone")).toBe("denied")

          const first = { caller: alice, command: "Post", kind: "command" }
          expect(globalSeen[0]).toMatchObject({ ...first, ref: { actor: "AccessGuarded" } })
          expect(actorSeen[0]).toMatchObject({ ...first, ref: { actor: "AccessGuarded" } })
          expect(actorSeen.some(({ ref }) => ref.actor === "AccessBare")).toBe(false)
        }),
      )
    },
  },
  {
    name: "applies an actor's access policy to live sessions on reauthorize: a revoked connection, stream, and feed each end with access_denied",
    run: ({ expect, environment }) => {
      let revoked = false
      const reauthorized: Array<string> = []

      const { Ledger, layer } = ledgerOf("AccessLive", (request) => {
        if (request.kind === "reauthorize") reauthorized.push(String(request.of))

        return (
          isSystem(request.caller) ||
          (isUser(request.caller) && request.caller.subject === "alice" && !revoked)
        )
      })

      return deploy(
        environment,
        layer,
        {},
        Effect.gen(function* () {
          const test = yield* ActorTest
          const ledger = yield* Ledger.get("live")
          yield* ledger.Post(1)

          const endOf = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
            endWith(Stream.runDrain(stream))

          const endWith = <A, E, R>(running: Effect.Effect<A, E, R>) =>
            running.pipe(
              Effect.exit,
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: () => Effect.die(new Error("The session outlived its revocation")),
              }),
            )

          const sessions = Effect.gen(function* () {
            const connection = yield* test.connect(ledger.ref, Watch, undefined)
            const { ref } = yield* Ledger.get("live")

            const feed = yield* openFeed({
              actors: yield* InternalActors,
              ref,
              tags: [Posted.identifier],
              caller: alice,
              expiresAt: undefined,
            })

            const pull = yield* Stream.toPull((yield* Ledger.get("live")).Ticks())
            yield* pull

            return { connection, feed, pull }
          }).pipe(Actor.as(alice))

          const { connection, feed, pull } = yield* sessions

          revoked = true

          const ends = yield* Effect.all(
            [endOf(connection.frames), endOf(feed.messages), endWith(Effect.forever(pull))],
            { concurrency: "unbounded" },
          )

          expect(ends.map(isDenied)).toEqual([true, true, true])
          expect([...new Set(reauthorized)].sort()).toEqual(["feed", "open", "stream"])
        }),
      )
    },
    timeoutMs: 60_000,
  },
  {
    name: "answers a served request from a User or Anonymous caller with 403 access_denied by default, and lets an actor's access, or Actor.access.public, allow them",
    run: ({ expect, environment }) => {
      const closed = ledgerOf("AccessServedClosed")
      const anonymous = ledgerOf("AccessServedPublic", ({ caller }) => isAnonymous(caller))

      const mine = ledgerOf(
        "AccessServedMine",
        ({ caller }) => isUser(caller) && caller.subject === "alice",
      )

      const open = ledgerOf("AccessServedOpen", Actor.access.public)

      const served = [closed.Ledger, anonymous.Ledger, mine.Ledger, open.Ledger]

      return deploy(
        environment,
        Layer.mergeAll(closed.layer, anonymous.layer, mine.layer, open.layer),
        {},
        Effect.gen(function* () {
          const { tenant } = yield* ActorTest
          const publicServer = yield* serveHttp({ actors: served, auth: Actor.auth.none })
          const tokenServer = yield* serveHttp({ actors: served })

          const whoami = (server: typeof publicServer, name: string, token?: string) =>
            Effect.gen(function* () {
              const reply = yield* server.send(`/actors/${name}/served/Whoami`, {
                key: yield* server.mint(),
                token,
              })

              return { status: reply.status, body: reply.body }
            })

          expect(yield* whoami(publicServer, "AccessServedClosed")).toMatchObject({ status: 403 })
          expect(yield* whoami(publicServer, "AccessServedMine")).toMatchObject({ status: 403 })
          expect(yield* whoami(publicServer, "AccessServedOpen")).toEqual({
            status: 200,
            body: "default/Anonymous/",
          })
          expect(yield* whoami(tokenServer, "AccessServedOpen", `${tenant}:bob`)).toEqual({
            status: 200,
            body: `${tenant}/User/bob`,
          })

          const anonymousReply = yield* whoami(publicServer, "AccessServedPublic")
          expect(anonymousReply).toEqual({ status: 200, body: "default/Anonymous/" })

          expect(yield* whoami(tokenServer, "AccessServedClosed", `${tenant}:alice`)).toMatchObject(
            {
              status: 403,
            },
          )
          expect(yield* whoami(tokenServer, "AccessServedPublic", `${tenant}:alice`)).toMatchObject(
            {
              status: 403,
            },
          )
          expect(yield* whoami(tokenServer, "AccessServedMine", `${tenant}:bob`)).toMatchObject({
            status: 403,
          })
          expect(yield* whoami(tokenServer, "AccessServedMine", `${tenant}:alice`)).toEqual({
            status: 200,
            body: `${tenant}/User/alice`,
          })

          const denied = yield* publicServer.send("/actors/AccessServedClosed/served/Whoami", {
            key: yield* publicServer.mint(),
          })

          expect(denied.body).toMatchObject({ reason: { code: "access_denied" } })

          const inProcess = yield* Effect.flatMap(closed.Ledger.get("served"), (handle) =>
            handle.Post(1),
          )

          expect(inProcess).toBe(1)
        }),
      )
    },
  },
  {
    name: "keeps internal commands System-only and off public handles when an actor's access allows everyone",
    run: ({ expect, environment }) => {
      const { Ledger, layer } = ledgerOf("AccessInternal", Actor.access.public)

      return deploy(
        environment,
        layer,
        {},
        Effect.gen(function* () {
          const ledger = yield* Ledger.get("internal")
          const actors = yield* PublicActors
          expect(Object.keys(ledger).sort()).toEqual(["Balance", "Post", "Ticks", "Whoami", "ref"])
          expect(Object.keys(Ledger.api)).not.toContain("Seal")

          for (const caller of [alice, Anonymous.make({})]) {
            const outcome = yield* executeForTest(
              Request.make({
                ref: ledger.ref,
                caller,
                command: "Seal",
                commandId: yield* actors.mintCommandId,
                payload: "{}",
              }),
            )

            expect(Outcome.guards.Defect(outcome)).toBe(true)
          }

          const test = yield* ActorTest
          const bound = yield* test.actor(Ledger, "internal")

          expect(yield* bound.system.Seal()).toBe("sealed")
        }),
      )
    },
  },
  {
    name: "sees Anonymous, never System, on every served entry point under Actor.auth.none, and denies it by default",
    timeoutMs: 120_000,
    run: ({ expect, environment }) => {
      const asked: Array<AccessRequest> = []

      const closed = ledgerOf("AccessGuardClosed")

      const open = ledgerOf("AccessGuardOpen", (request) => {
        asked.push(request)

        return (
          isSystem(request.caller) ||
          (isAnonymous(request.caller) && request.kind !== "reauthorize")
        )
      })

      return deploy(
        environment,
        Layer.merge(closed.layer, open.layer),
        {},
        Effect.gen(function* () {
          for (const Ledger of [closed.Ledger, open.Ledger])
            yield* Effect.flatMap(Ledger.get("guard"), (ledger) => ledger.Post(1)).pipe(
              Actor.tenant("default"),
            )

          asked.length = 0

          const context = yield* Effect.context<Services>()

          const app = Layer.mergeAll(
            Actor.serve({
              actors: [closed.Ledger, open.Ledger],
              auth: Actor.auth.none,
              basePath: "/api",
              mcp: { path: "/mcp" },
            }),
            Operators.serve({ auth: OperatorAuth.tokens([]) }),
            Telemetry.serve(),
            Inspector.serve({ auth: Actor.auth.none }),
          ).pipe(Layer.provide(Layer.succeedContext(context)))

          const built = yield* Layer.build(
            HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }).pipe(
              Layer.provideMerge(environment.httpServer),
            ),
          )

          const address = Context.get(built, HttpServer.HttpServer).address

          if (Predicate.isTagged(address, "UnixPathAddress"))
            return yield* Effect.die(new Error("Expected a TCP address"))

          const host = `127.0.0.1:${address.port}`
          const api = `http://${host}/api`

          const mint = fetchText(`${api}/command-ids`, { method: "POST" }).pipe(
            Effect.flatMap(({ text }) => decodeMinted(text).pipe(Effect.orDie)),
            Effect.map(({ commandId }) => commandId),
          )

          const entryPoints = (name: string) =>
            Effect.gen(function* () {
              const actor = `${api}/actors/${name}/guard`

              return {
                command: yield* fetchText(`${actor}/Whoami`, {
                  method: "POST",
                  headers: { "idempotency-key": yield* mint },
                }),
                query: yield* fetchText(`${actor}/Balance`, { method: "POST" }),
                stream: yield* fetchText(`${actor}/Ticks`, { method: "POST" }),
                feed: yield* fetchText(`${actor}/events?event=${Posted.identifier}&after=0`),
                socket: {
                  status: 0,
                  text: yield* socketMessages(`ws://${host}/api/actors/${name}/guard/Watch`),
                },
                download: yield* fetchText(`${actor}/content/files/file`),
                grant: yield* fetchText(`${actor}/content/files/file/grant`, { method: "POST" }),
                mcp: yield* fetchText(`${api}/mcp`, {
                  method: "POST",
                  headers: { ...MCP_VERSION_HEADERS, "mcp-name": `${name}.Whoami` },
                  body: {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: {
                      name: `${name}.Whoami`,
                      arguments: { id: "guard", commandId: yield* mint },
                      _meta: {
                        "io.modelcontextprotocol/protocolVersion": MCP_VERSION,
                        "io.modelcontextprotocol/clientCapabilities": {},
                      },
                    },
                  },
                }),
              }
            })

          const refused = yield* entryPoints("AccessGuardClosed")

          expect(
            Object.fromEntries(
              Object.entries(refused).map(([entry, reply]) => [entry, deniedReply(reply)]),
            ),
          ).toEqual({
            command: true,
            query: true,
            stream: true,
            feed: true,
            socket: true,
            download: true,
            grant: true,
            mcp: true,
          })

          const served = yield* entryPoints("AccessGuardOpen")

          expect(served.command).toEqual({
            status: 200,
            text: '"default/Anonymous/"',
          })
          expect(served.mcp.text).toContain("default/Anonymous/")
          expect(served.query.status).toBe(200)
          expect(served.stream.text).toContain("access_denied")
          expect(served.feed.text).toContain("access_denied")
          expect(served.socket.text).toContain("access_denied")

          const operator = yield* fetchText(
            `http://${host}/operator/actors/AccessGuardOpen/guard?tenant=default`,
          )

          expect(operator.status).toBe(401)
          expect((yield* fetchText(`http://${host}/metrics`)).status).toBe(200)
          expect((yield* fetchText(`http://${host}/inspector/overview`)).status).toBe(200)

          expect(asked.filter(({ caller }) => !isAnonymous(caller))).toEqual([])
          expect([...new Set(asked.map(({ kind }) => kind))].sort()).toEqual([
            "command",
            "content",
            "feed",
            "open",
            "query",
            "reauthorize",
            "stream",
          ])
        }),
      )
    },
  },
]
