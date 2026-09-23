import { expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { Manifest, selectUpdate, updateCatalogs } from "./catalogs.ts"

it("selects numeric patch/minor upgrades but never major, downgrade or prerelease", () => {
  expect(
    selectUpdate({
      current: "3.2.9",
      versions: ["3.2.10", "3.11.0", "4.0.0", "3.12.0-beta.1"],
    }).version,
  ).toBe("3.11.0")
  expect(selectUpdate({ current: "3.2.9", versions: ["3.1.0"] }).version).toBe("3.2.9")
  expect(
    selectUpdate({ current: "4.0.0-rc.116", versions: ["4.0.0-rc.117", "4.0.0"] }).blocked,
  ).toContain("proof")
})

it("updates default and named Bun catalogs without mutating input or coupled pins", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = {
        workspaces: {
          catalog: { zod: "3.1.0", effect: "4.0.0-rc.116" },
          catalogs: { tools: { typescript: "7.0.2", other: "1.0.1" } },
        },
      }

      const registry = new Map([
        ["zod", ["3.2.0"]],
        ["effect", ["4.0.0"]],
        ["typescript", ["7.1.0"]],
        ["other", ["1.0.2"]],
      ])

      const result = yield* updateCatalogs(input, (name) =>
        Effect.succeed(registry.get(name) ?? []),
      )

      expect(result.manifest.workspaces?.catalog?.zod).toBe("3.2.0")
      expect(result.manifest.workspaces?.catalogs?.tools).toEqual({
        typescript: "7.0.2",
        other: "1.0.2",
      })
      expect(input.workspaces.catalog.zod).toBe("3.1.0")
      expect(result.report.filter((x) => x.blocked !== undefined)).toHaveLength(2)
    }),
  ))

it("preserves non-catalog manifest data through the same JSON decoder used by the CLI", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(
        '{"name":"project","private":true,"scripts":{"test":"vitest"},"workspaces":{"packages":["apps/*"],"catalog":{"zod":"3.1.0"}}}',
      )

      const result = yield* updateCatalogs(manifest, () => Effect.succeed(["3.2.0", "4.0.0"]))
      expect(result.manifest).toEqual({
        name: "project",
        private: true,
        scripts: { test: "vitest" },
        workspaces: { packages: ["apps/*"], catalog: { zod: "3.2.0" } },
      })
    }),
  ))
