import { expect, it } from "vitest"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime, Schema } from "effect"

const Report = Schema.fromJsonString(
  Schema.Struct({
    tasks: Schema.Array(
      Schema.Struct({
        taskId: Schema.String,
        hash: Schema.String,
        command: Schema.String,
        dependencies: Schema.Array(Schema.String),
        resolvedTaskDefinition: Schema.Struct({ cache: Schema.Boolean }),
      }),
    ),
  }),
)

it("Turbo selects changed tasks, propagates dependency changes, and keeps integration uncached", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)

  return runtime
    .runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped()
        const source = new URL("../../", import.meta.url).pathname
        const turbo = `${source}node_modules/turbo/bin/turbo`

        const run = (args: string[]) => {
          const result = Bun.spawnSync(args, { cwd: root })
          expect(result.exitCode, result.stderr.toString()).toBe(0)

          return result.stdout.toString().trim()
        }

        yield* fs.copyFile(`${source}turbo.json`, `${root}/turbo.json`)
        yield* fs.writeFileString(
          `${root}/package.json`,
          '{"name":"graph-fixture","private":true,"packageManager":"bun@1.4.2","workspaces":["packages/*","apps/*","infra"]}',
        )
        yield* fs.writeFileString(`${root}/.gitignore`, "node_modules/\n.turbo/\n.cache/\n")
        yield* fs.writeFileString(`${root}/tsconfig.json`, "{}")
        yield* fs.writeFileString(`${root}/.oxlintrc.json`, "{}")
        yield* fs.writeFileString(`${root}/vitest.config.ts`, "export default {}")

        for (const [path, name, dependencies] of [
          ["packages/ui", "@project/ui", "{}"],
          ["apps/web", "@project/web", '{"@project/ui":"workspace:*"}'],
          ["apps/api", "@project/api", "{}"],
          ["infra", "@project/infra", "{}"],
        ]) {
          yield* fs.makeDirectory(`${root}/${path}/src`, { recursive: true })
          yield* fs.writeFileString(
            `${root}/${path}/package.json`,
            `{"name":"${name}","dependencies":${dependencies},"scripts":{"lint":"true","typecheck":"true","build":"true","test":"true","test:integration":"true"}}`,
          )
          yield* fs.writeFileString(`${root}/${path}/src/index.ts`, "export const value = 1")
          yield* fs.writeFileString(`${root}/${path}/README.md`, "Initial docs")
        }

        yield* fs.makeDirectory(`${root}/.github/src`, { recursive: true })
        yield* fs.writeFileString(`${root}/.github/src/policy.ts`, "export const policy = 1")
        yield* fs.makeDirectory(`${root}/tooling/oxlint/anti-slop`, { recursive: true })
        yield* fs.writeFileString(`${root}/tooling/oxlint/anti-slop/index.ts`, "export default {}")
        run(["bun", "install", "--lockfile-only", "--ignore-scripts"])
        run(["git", "init", "-q"])
        run(["git", "add", "."])
        run([
          "git",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-qm",
          "baseline",
        ])
        const base = run(["git", "rev-parse", "HEAD"])
        const tasks = ["lint", "typecheck", "test", "build", "test:integration"]

        const report = () =>
          Schema.decodeEffect(Report)(
            run([turbo, "run", ...tasks, "--dry=json", "--cache=local:rw"]),
          )

        const baseline = yield* report()

        const hash = (result: typeof baseline, id: string) =>
          result.tasks.find((task) => task.taskId === id)?.hash

        const affected = () =>
          Schema.decodeEffect(Report)(
            run([
              "env",
              "-u",
              "TURBO_SCM_HEAD",
              `TURBO_SCM_BASE=${base}`,
              turbo,
              "run",
              ...tasks,
              "--affected",
              "--dry=json",
              "--cache=local:rw",
            ]),
          )

        expect(
          baseline.tasks.find((task) => task.taskId === "@project/web#typecheck")?.dependencies,
        ).toEqual(["@project/web#transit"])
        expect(
          baseline.tasks.find((task) => task.taskId === "@project/api#test:integration")
            ?.resolvedTaskDefinition.cache,
        ).toBe(false)
        yield* fs.writeFileString(`${root}/packages/ui/README.md`, "Changed docs")
        const docs = yield* report()
        expect(hash(docs, "@project/web#typecheck")).toBe(hash(baseline, "@project/web#typecheck"))
        expect(hash(docs, "@project/ui#build")).toBe(hash(baseline, "@project/ui#build"))
        expect(
          (yield* affected()).tasks.filter((task) => task.command !== "<NONEXISTENT>"),
        ).toEqual([])

        yield* fs.writeFileString(
          `${root}/packages/ui/src/index.ts`,
          'export const value = "breaking"',
        )
        const changed = yield* report()
        expect(hash(changed, "@project/web#typecheck")).not.toBe(
          hash(baseline, "@project/web#typecheck"),
        )
        expect(hash(changed, "@project/api#typecheck")).toBe(
          hash(baseline, "@project/api#typecheck"),
        )
        const selected = (yield* affected()).tasks.map((task) => task.taskId)
        expect(selected).toContain("@project/web#typecheck")
        expect(selected).not.toContain("@project/api#typecheck")

        yield* fs.writeFileString(`${root}/.github/src/policy.ts`, "export const policy = 2")
        expect(hash(yield* report(), "@project/infra#typecheck")).not.toBe(
          hash(changed, "@project/infra#typecheck"),
        )
        yield* fs.writeFileString(
          `${root}/tooling/oxlint/anti-slop/index.ts`,
          "export default { changed: true }",
        )
        expect(hash(yield* report(), "@project/api#lint")).not.toBe(
          hash(changed, "@project/api#lint"),
        )
      }).pipe(Effect.scoped),
    )
    .finally(() => runtime.dispose())
}, 30_000)
