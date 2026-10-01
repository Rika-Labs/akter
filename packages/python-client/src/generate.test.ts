import { Actor, Unauthorized, User } from "@rikalabs/akter"
import { Actors, Auth } from "@rikalabs/akter/runtime"
import { ActorTest } from "@rikalabs/akter/testing"
import { BunCrypto, BunServices } from "@effect/platform-bun"
import {
  Effect,
  Exit,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  Schema,
  Stream,
} from "effect"
import { FetchHttpClient, Headers, HttpClient, HttpRouter } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { afterAll, beforeAll, expect, it } from "vitest"
import { generate } from "./generate.ts"

class Full extends Schema.TaggedError<Full>()("Full", { capacity: Schema.Int }) {}

const Post = Actor.command("Post", {
  payload: { text: Schema.String, file: Schema.optionalKey(Schema.String) },
  success: Schema.Int,
  error: Full,
})

const Whoami = Actor.command("Whoami", { success: Schema.String })

const Clear = Actor.command("Clear")

const Secret = Actor.command("Secret")

const Count = Actor.query("Count", { success: Schema.Int })

const Peek = Actor.query("Peek", { success: Schema.UndefinedOr(Schema.Int) })

const Recent = Actor.query("Recent", {
  payload: { limit: Schema.Int },
  success: Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.Literals(["a", "b"]) })),
})

const count = Actor.state({
  count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

const Room = Actor.make("Room", {
  key: Schema.String,
  state: count,
  api: { Post, Whoami, Clear, Count, Peek, Recent },
  internal: { Secret },
  access: Actor.access.public,
})

const Join = Actor.command("Join", { success: Schema.Int })

const Lobby = Actor.make("Lobby", {
  key: Actor.singleton,
  state: count,
  api: { Join },
  access: Actor.access.public,
})

const runs = { count: 0 }

const rooms = Room.toLayer({
  Post: Effect.fnUntraced(function* ({ text }) {
    const turn = yield* Room.Turn
    runs.count += 1
    yield* turn.state.set({ count: turn.state.count + 1 })

    return text === "full" ? yield* Full.make({ capacity: 3 }) : turn.state.count
  }),
  Whoami: Effect.fnUntraced(function* () {
    const turn = yield* Room.Turn

    return `${turn.ref.tenant}/${Schema.is(User)(turn.caller) ? turn.caller.subject : "anonymous"}`
  }),
  Clear: () => Effect.void,
  Secret: () => Effect.void,
})

const reads = Room.toQueryLayer({
  Count: Effect.fnUntraced(function* () {
    return (yield* Room.Read).state.count
  }),
  Peek: Effect.fnUntraced(function* () {
    const { count } = (yield* Room.Read).state

    return count === 0 ? undefined : count
  }),
  Recent: () => Effect.succeed([{ id: "m1", kind: "a" as const }]),
})

const lobbies = Lobby.toLayer({
  Join: Effect.fnUntraced(function* () {
    const turn = yield* Lobby.Turn
    yield* turn.state.set({ count: turn.state.count + 1 })

    return turn.state.count
  }),
})

const auth = Auth.make((request) =>
  Option.match(Headers.get(request.headers, "authorization"), {
    onNone: () => Effect.fail(Unauthorized.make({ code: "missing_credentials" })),
    onSome: (header) => {
      const match = /^Bearer ([a-z0-9-]+):([a-z0-9-]+)$/.exec(header)

      return match === null
        ? Effect.fail(Unauthorized.make({ code: "invalid_credentials" }))
        : Effect.succeed({ tenant: match[1]!, caller: User.make({ subject: match[2]! }) })
    },
  }),
)

const web = HttpRouter.toWebHandler(
  Actors.serve({
    actors: [Room, Lobby],
    auth,
    basePath: "/api",
    openapi: { path: "/openapi.json" },
  }).pipe(
    Layer.provide(
      Layer.mergeAll(rooms, reads, lobbies).pipe(
        Layer.provideMerge(ActorTest.layer({ retryWindowMs: 60_000 })),
      ),
    ),
    Layer.provide(BunCrypto.layer),
  ),
  { disableLogger: true },
)

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => web.handler(request),
})

const origin = `http://127.0.0.1:${server.port}`

const harness = ManagedRuntime.make(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const Spec = Schema.Struct({
  paths: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.Struct({ operationId: Schema.String })),
  ),
})

/** The generated package and the scripts that use it live in one directory per run. */
const directory = new URL(`../.cache/${Bun.randomUUIDv7()}`, import.meta.url).pathname

const document = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.get(`${origin}/api/openapi.json`)

  return yield* response.json
})

const readRuntime = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem

  return yield* fs.readFileString(new URL("../python/runtime.py", import.meta.url).pathname)
})

/** Runs a Python script in the scratch directory and decodes what it prints. */
const python = (script: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const path = yield* Path.Path
    yield* fs.writeFileString(path.join(directory, "script.py"), script)

    const handle = yield* spawner.spawn(
      ChildProcess.make("python3", ["script.py", ...args], { cwd: directory }),
    )

    const [out, err] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText, Stream.mkString),
        handle.stderr.pipe(Stream.decodeText, Stream.mkString),
      ],
      { concurrency: 2 },
    )

    yield* handle.exitCode

    return { err, printed: out === "" ? undefined : yield* decodeJson(out) }
  }).pipe(Effect.scoped)

const generated = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    return yield* fs.readFileString(path.join(directory, "rooms_client", file))
  })

beforeAll(() =>
  harness.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      yield* fs.makeDirectory(directory, { recursive: true })

      const files = yield* generate({
        document: yield* document,
        name: "rooms_client",
        runtime: yield* readRuntime,
      })

      for (const [file, contents] of Object.entries(files)) {
        const target = path.join(directory, file)
        yield* fs.makeDirectory(path.dirname(target), { recursive: true })
        yield* fs.writeFileString(target, contents)
      }
    }),
  ),
)

afterAll(() =>
  harness
    .runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* Effect.promise(() => server.stop(true))
        yield* Effect.promise(() => web.dispose())
        yield* fs.remove(directory, { recursive: true })
      }),
    )
    .finally(() => harness.dispose()),
)

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner.ChildProcessSpawner
    | HttpClient.HttpClient
  >,
) => harness.runPromise(effect)

it("names one method per public member by its OpenAPI operation id, and none for an internal member", () =>
  run(
    Effect.gen(function* () {
      const spec = yield* Schema.decodeUnknownEffect(Spec)(yield* document)

      const operationIds = Object.values(spec.paths)
        .flatMap((methods) => Object.values(methods).map((operation) => operation.operationId))
        .filter((id) => id.startsWith("Room.") || id.startsWith("Lobby."))

      const result = yield* python(
        [
          "import json",
          "from rooms_client import Client, OPERATIONS",
          "client = Client('http://unused')",
          "print(json.dumps({'operations': sorted(OPERATIONS), 'secret': hasattr(client.room, 'secret'), 'lobby': hasattr(client, 'lobby')}))",
        ].join("\n"),
      )

      expect(result.err).toBe("")

      expect(result.printed).toEqual({
        operations: operationIds.sort(),
        secret: false,
        lobby: true,
      })

      expect(operationIds).not.toContain("Room.Secret")
    }),
  ))

it("compiles and types every schema the public members use", () =>
  run(
    Effect.gen(function* () {
      const models = yield* generated("models.py")
      const client = yield* generated("client.py")

      expect(models).toContain('"RoomPostInput"')
      expect(models).toContain('Literal["a", "b"]')

      expect(client).toContain(
        'def post(self, id: str, input: "RoomPostInput", /, *, command_id: Optional[str] = None) -> int:',
      )

      expect(client).toContain("def join(self, /, *, command_id: Optional[str] = None) -> int:")
      expect(client).toContain(
        "def clear(self, id: str, /, *, command_id: Optional[str] = None) -> None:",
      )
      expect(client).toContain('"Room.Post": ["Full"]')

      const compiled = yield* python(
        "import py_compile, sys\nfor name in ('__init__', '_runtime', 'client', 'models'):\n    py_compile.compile('rooms_client/%s.py' % name, doraise=True)\nprint('true')",
      )

      expect(compiled).toEqual({ err: "", printed: true })
    }),
  ))

it("runs a command once per command id against a real server, replays it, and refuses reuse with other input", () =>
  run(
    Effect.gen(function* () {
      const before = runs.count

      const result = yield* python(
        [
          "import json, sys",
          "from rooms_client import Client, CommandConflict, CommandExpired, DeclaredError, Unauthorized",
          "client = Client(sys.argv[1], token='t1:alice')",
          "out = {}",
          "key = client.mint_command_id()",
          "out['first'] = client.room.post('r1', {'text': 'a'}, command_id=key)",
          "out['replay'] = client.room.post('r1', {'text': 'a'}, command_id=key)",
          "out['other'] = client.room.post('r1', {'text': 'b'})",
          "try:",
          "    client.room.post('r1', {'text': 'b'}, command_id=key)",
          "except CommandConflict as error:",
          "    out['conflict'] = [error.tag, error.status, error.command_id == key]",
          "old = 'v1.1000.61000.00000000-0000-4000-8000-000000000000'",
          "try:",
          "    client.room.post('r1', {'text': 'a'}, command_id=old)",
          "except CommandExpired as error:",
          "    out['expired'] = [error.tag, error.status]",
          "try:",
          "    client.room.post('r2', {'text': 'full'})",
          "except DeclaredError as error:",
          "    out['declared'] = [error.tag, error.status, error.body['capacity']]",
          "for label, token in (('missing', None), ('invalid', 'nope')):",
          "    try:",
          "        Client(sys.argv[1], token=token).room.count('r1')",
          "    except Unauthorized as error:",
          "        out[label] = [error.code, error.status]",
          "print(json.dumps(out))",
        ].join("\n"),
        origin,
      )

      expect(result.err).toBe("")

      expect(result.printed).toEqual({
        first: 1,
        replay: 1,
        other: 2,
        conflict: ["CommandConflict", 409, true],
        expired: ["CommandExpired", 410],
        declared: ["Full", 422, 3],
        missing: ["missing_credentials", 401],
        invalid: ["invalid_credentials", 401],
      })

      expect(runs.count - before).toBe(3)
    }),
  ))

it("answers queries, void commands, singletons, and per-token principals like the routes", () =>
  run(
    Effect.gen(function* () {
      const result = yield* python(
        [
          "import json, sys",
          "from rooms_client import Client",
          "alice = Client(sys.argv[1], token='t2:alice')",
          "bob = Client(sys.argv[1], token=lambda: 't2:bob')",
          "print(json.dumps({",
          "  'peek': alice.room.peek('fresh'),",
          "  'recent': alice.room.recent('fresh', {'limit': 5}),",
          "  'clear': alice.room.clear('fresh'),",
          "  'join': alice.lobby.join(),",
          "  'alice': alice.room.whoami('w'),",
          "  'bob': bob.room.whoami('w'),",
          "  'count': alice.room.count('fresh'),",
          "}))",
        ].join("\n"),
        origin,
      )

      expect(result.err).toBe("")

      expect(result.printed).toEqual({
        peek: null,
        recent: [{ id: "m1", kind: "a" }],
        clear: null,
        join: 1,
        alice: "t2/alice",
        bob: "t2/bob",
        count: 0,
      })
    }),
  ))

it("retries a command whose reply was lost with the same id, and the server runs it once", () =>
  run(
    Effect.gen(function* () {
      const before = runs.count

      const result = yield* python(
        [
          "import json, sys",
          "from rooms_client import Client, _runtime",
          "lost = {'left': 1}",
          "def transport(method, url, headers, body, timeout):",
          "    reply = _runtime.urllib_transport(method, url, headers, body, timeout)",
          "    if method == 'POST' and 'idempotency-key' in headers and lost['left'] > 0:",
          "        lost['left'] -= 1",
          "        raise _runtime.NetworkFailure('reply lost')",
          "    return reply",
          "client = Client(sys.argv[1], token='t3:alice', transport=transport, sleep=lambda s: None)",
          "print(json.dumps({'value': client.room.post('lost', {'text': 'a'}), 'lost': lost['left']}))",
        ].join("\n"),
        origin,
      )

      expect(result.err).toBe("")
      expect(result.printed).toEqual({ value: 1, lost: 0 })
      expect(runs.count - before).toBe(1)
    }),
  ))

it("refuses a package name that is not a Python module name, and a document without protocol routes", () =>
  run(
    Effect.gen(function* () {
      const runtime = yield* readRuntime
      const bad = yield* generate({ document: {}, name: "Not-A-Module", runtime }).pipe(Effect.exit)
      expect(Exit.isFailure(bad)).toBe(true)

      const empty = yield* generate({
        document: { openapi: "3.1.0", paths: {}, components: { schemas: {} } },
        name: "empty",
        runtime,
      }).pipe(Effect.exit)

      expect(Exit.isFailure(empty)).toBe(true)
    }),
  ))
