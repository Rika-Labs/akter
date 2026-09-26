import { expect, it } from "vitest"
import {
  publishManifest,
  tarballProblems,
  undeclaredImports,
  type FrameworkManifest,
} from "./manifest.ts"

const manifest: FrameworkManifest = {
  name: "@durable-actors/core",
  version: "0.1.0-alpha.0",
  files: ["dist"],
  types: "./src/index.ts",
  exports: { ".": "./src/index.ts", "./runtime": "./src/runtime/index.ts" },
  scripts: { build: "tsc -p tsconfig.build.json" },
  dependencies: { "@electric-sql/pglite": "0.5.8" },
  peerDependencies: { effect: "catalog:" },
  devDependencies: { vitest: "catalog:" },
  publishConfig: {
    access: "public",
    types: "./dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./runtime": { types: "./dist/runtime/index.d.ts", default: "./dist/runtime/index.js" },
      "./package.json": "./package.json",
    },
  },
}

const complete = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/runtime/index.js",
  "dist/runtime/index.d.ts",
]

it("points the published manifest at dist, resolves the catalog, and drops dev-only fields", () => {
  const packed = publishManifest({ manifest, catalog: { effect: "4.0.0-rc.116", vitest: "5.0.1" } })

  expect(packed.types).toBe("./dist/index.d.ts")
  expect(packed.exports).toEqual(manifest.publishConfig.exports)
  expect(packed.dependencies).toEqual({ "@electric-sql/pglite": "0.5.8" })
  expect(packed.peerDependencies).toEqual({ effect: "4.0.0-rc.116" })
  expect(packed.publishConfig).toEqual({ access: "public" })
  expect(packed).not.toHaveProperty("scripts")
  expect(packed).not.toHaveProperty("devDependencies")
  expect(manifest.peerDependencies?.effect).toBe("catalog:")
})

it("refuses workspace dependencies and catalog entries the root doesn't define", () => {
  expect(() =>
    publishManifest({
      manifest: { ...manifest, dependencies: { "@durable-actors/postgres": "workspace:*" } },
      catalog: {},
    }),
  ).toThrow("workspace dependency")
  expect(() => publishManifest({ manifest, catalog: {} })).toThrow("effect has no version")
})

it("refuses a private framework manifest before packing", () => {
  expect(() => publishManifest({ manifest: { ...manifest, private: true }, catalog: {} })).toThrow(
    "framework manifest is private",
  )
})

it("accepts a complete tarball and names every missing, leaked, or unresolved entry", () => {
  const packed = publishManifest({ manifest, catalog: { effect: "4.0.0-rc.116" } })

  expect(tarballProblems({ files: complete, manifest: packed })).toEqual([])
  expect(
    tarballProblems({
      files: [
        ...complete.filter((file) => file !== "NOTICE" && file !== "dist/runtime/index.d.ts"),
        "src/index.ts",
        "dist/actor/definition.test.js",
        "dist/testing/conformance/crash/main.js",
        "dist/runtime/layer.ts",
      ],
      manifest: {
        ...packed,
        private: true,
        peerDependencies: { effect: "catalog:" },
        version: "next",
      },
    }),
  ).toEqual([
    "missing NOTICE",
    "missing dist/runtime/index.d.ts",
    "must not publish src/index.ts",
    "must not publish dist/actor/definition.test.js",
    "must not publish dist/testing/conformance/crash/main.js",
    "must not publish dist/runtime/layer.ts",
    "manifest is private",
    "dependency effect is unresolved (catalog:)",
    "version next is not a semantic version",
  ])
})

it("names bare imports that are neither builtins nor declared dependencies or peers", () => {
  const packed = publishManifest({ manifest, catalog: { effect: "4.0.0-rc.116" } })

  expect(
    undeclaredImports({
      sources: [
        'import { Effect } from "effect";\nimport { SqlClient } from "effect/unstable/sql";',
        'export { PGlite } from "@electric-sql/pglite";\nimport "./local.js";',
        'const { heapStats } = await import("bun:jsc");\nimport net from "node:net";',
        'import { Pool } from "pg";\nimport { BunServices } from "@effect/platform-bun/BunServices";',
      ],
      manifest: packed,
    }),
  ).toEqual(["@effect/platform-bun", "pg"])
})

it("accepts valid SemVer build metadata", () => {
  const packed = publishManifest({
    manifest: { ...manifest, version: "1.2.3-alpha.1+build.5" },
    catalog: { effect: "4.0.0-rc.116" },
  })

  expect(tarballProblems({ files: complete, manifest: packed })).toEqual([])
})
