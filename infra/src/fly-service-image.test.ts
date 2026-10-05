import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { createFlyHostedSupport } from "alchemy/Fly/hosted"
import { Credentials } from "alchemy/Fly"
import { Stack } from "alchemy/Stack"
import { Stage } from "alchemy/Stage"
import { Effect, FileSystem, Layer, ManagedRuntime, Path } from "effect"
import { PlatformError, SystemError, type SystemErrorTag } from "effect/PlatformError"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as HttpClient from "effect/http/HttpClient"
import { afterAll, expect, it } from "vitest"

type Built = { readonly dir: string; readonly files: ReadonlyArray<string> }

type Site = { readonly main: string; readonly source: string }

type Services =
  | FileSystem.FileSystem
  | Path.Path
  | Stack
  | Stage
  | ChildProcessSpawner
  | HttpClient.HttpClient
  | Credentials

const imageMissing: SystemErrorTag = "NotFound"

const buildStopped: SystemErrorTag = "Unknown"

/**
 * What resolving an image touches before the build starts is the filesystem, the stack and the
 * stage. The process spawner, the HTTP client and the Fly credentials serve the install step and
 * the registry push, which these images never reach.
 */
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer,
    Layer.succeed(Stack, { name: "akter", stage: "prod" } as never),
    Layer.succeed(Stage, "prod"),
    Layer.succeed(ChildProcessSpawner, {} as never),
    Layer.succeed(HttpClient.HttpClient, {} as never),
    Layer.succeed(Credentials, {} as never),
  ),
)

afterAll(() => runtime.dispose())

/**
 * A built site: its files and the generated serve entry beside them, which every site's build
 * names the same.
 */
const site = (root: string, name: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const out = path.join(root, name, "dist")
    yield* fs.makeDirectory(out, { recursive: true })
    yield* Effect.forEach(
      Object.entries({ "serve-node.mjs": `export const site = "${name}"\n`, ...files }),
      ([file, content]) => fs.writeFileString(path.join(out, file), content),
    )
    return { main: path.join(out, "serve-node.mjs"), source: out }
  })

/**
 * Resolves the image of one `Fly.Service` named `Service`, as every framework website names its
 * own. Docker is a recorder that lists the build context when the image build starts and then
 * stops the build, so no registry or deploy token is involved.
 */
const resolve = (root: string, app: string, built: Site) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const started: Built[] = []
    const recorder = {
      materialize: () => Effect.void,
      image: {
        inspect: () =>
          Effect.fail(
            new PlatformError(
              new SystemError({ _tag: imageMissing, module: "Docker", method: "inspect" }),
            ),
          ),
        build: (options: { context: string }) =>
          Effect.gen(function* () {
            const files = yield* fs.readDirectory(options.context, { recursive: true })
            started.push({ dir: options.context, files: files.toSorted() })
            return yield* new PlatformError(
              new SystemError({ _tag: buildStopped, module: "Docker", method: "build" }),
            )
          }),
      },
    }
    const support = createFlyHostedSupport({
      stackName: "akter",
      stage: "prod",
      virtualEntryPlugin: () => ({ name: "unused" }),
      docker: recorder as never,
      dotAlchemy: `${root}/.alchemy`,
    })
    const resolving: Effect.Effect<unknown, PlatformError, Services> = support.resolveImage({
      id: "Service",
      appName: app,
      props: {
        main: built.main,
        isExternal: true,
        extraFiles: [{ source: built.source, dest: "." }],
      },
    })
    yield* Effect.exit(resolving)
    return started
  })

it("builds each Fly service from its own files when two services in a stage share the id Service", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "akter-fly-service-image-" })
      const console = yield* site(root, "console", { "index.html": "console", "app.js": "console" })
      const home = yield* site(root, "home", { "index.html": "home", "404.html": "home" })
      const [first] = yield* resolve(root, "akter-prod-console", console)
      const [second] = yield* resolve(root, "akter-prod-site", home)
      expect(first?.dir).not.toBe(second?.dir)
      expect(first?.files).toEqual(["app.js", "index.html", "serve-node.mjs"])
      expect(second?.files).toEqual(["404.html", "index.html", "serve-node.mjs"])
      expect(yield* fs.readFileString(`${first?.dir ?? ""}/index.html`)).toBe("console")
      expect(yield* fs.readFileString(`${second?.dir ?? ""}/index.html`)).toBe("home")
    }).pipe(Effect.scoped),
  ))
