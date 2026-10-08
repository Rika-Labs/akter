import { expect, it } from "vitest"
import {
  publishManifest,
  tarballProblems,
  undeclaredImports,
  type FrameworkManifest,
} from "./manifest.ts"

const manifest: FrameworkManifest = {
  name: "@rikalabs/akter",
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
  expect(packed.peerDependencies).toEqual({ effect: "^4.0.0-rc.116" })
  expect(packed.publishConfig).toEqual({ access: "public" })
  expect(packed).not.toHaveProperty("scripts")
  expect(packed).not.toHaveProperty("devDependencies")
  expect(manifest.peerDependencies?.effect).toBe("catalog:")
})

it("ranges shared-library peers without widening runtime dependencies or unrelated peers", () => {
  const packed = publishManifest({
    manifest: {
      ...manifest,
      dependencies: { "@effect/platform-node-shared": "catalog:" },
      peerDependencies: {
        effect: "catalog:",
        "@effect/sql-pg": "catalog:",
        "@effect/platform-bun": "catalog:",
        "drizzle-orm": "catalog:",
        "other-library": "2.3.4",
      },
      peerDependenciesMeta: { "@effect/platform-bun": { optional: true } },
    },
    catalog: {
      effect: "4.0.0",
      "@effect/sql-pg": "4.0.0",
      "@effect/platform-bun": "4.0.0",
      "@effect/platform-node-shared": "4.0.0",
      "drizzle-orm": "1.0.0-rc.5-5935859",
    },
  })
  expect(packed.dependencies).toEqual({ "@effect/platform-node-shared": "4.0.0" })
  expect(packed.peerDependencies).toEqual({
    effect: "^4.0.0",
    "@effect/sql-pg": "^4.0.0",
    "@effect/platform-bun": "^4.0.0",
    "drizzle-orm": "^1.0.0-rc.5-5935859",
    "other-library": "2.3.4",
  })
  expect(packed.peerDependenciesMeta).toEqual({ "@effect/platform-bun": { optional: true } })
  expect(packed.dependencies).not.toHaveProperty("effect")
  expect(manifest.peerDependencies?.effect).toBe("catalog:")
})

it("refuses workspace dependencies and catalog entries the root doesn't define", () => {
  expect(() =>
    publishManifest({
      manifest: { ...manifest, dependencies: { "@akter/postgres": "workspace:*" } },
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
        'import { Effect } from "effect";\nimport { SqlClient } from "effect/sql";',
        'export { PGlite } from "@electric-sql/pglite";\nimport "./local.js";',
        'const { heapStats } = await import("bun:jsc");\nimport net from "node:net";',
        'import { Pool } from "pg";\nimport { BunServices } from "@effect/platform-bun/BunServices";',
      ],
      manifest: packed,
    }),
  ).toEqual(["@effect/platform-bun", "pg"])
})

it("keeps the app testing entry but rejects compiled framework verification harnesses", () => {
  const packed = publishManifest({ manifest, catalog: { effect: "4.0.2" } })
  const publicTesting = ["dist/testing/index.js", "dist/testing/actor-test.d.ts"]
  const harnesses = [
    "dist/testing/conformance.js",
    "dist/testing/conformance/counter.d.ts",
    "dist/testing/foundation.js",
    "dist/testing/cluster.d.ts",
    "dist/testing/simulate.js",
    "dist/testing/simulate-cluster.d.ts",
  ]

  expect(tarballProblems({ files: [...complete, ...publicTesting], manifest: packed })).toEqual([])
  expect(
    tarballProblems({ files: [...complete, ...publicTesting, ...harnesses], manifest: packed }),
  ).toEqual(harnesses.map((file) => `must not publish ${file}`))
})

it("accepts valid SemVer build metadata", () => {
  const packed = publishManifest({
    manifest: { ...manifest, version: "1.2.3-alpha.1+build.5" },
    catalog: { effect: "4.0.0-rc.116" },
  })

  expect(tarballProblems({ files: complete, manifest: packed })).toEqual([])
})

it("names undeclared bare imports written with single quotes", () => {
  const packed = publishManifest({ manifest, catalog: { effect: "4.0.0-rc.116" } })

  expect(
    undeclaredImports({
      sources: [
        "import { x } from 'optional-driver'",
        "export { y } from 'reexported'",
        "await import('dynamic-driver')",
        "import 'side-effect'",
        "import { Effect } from 'effect'",
      ],
      manifest: packed,
    }),
  ).toEqual(["dynamic-driver", "optional-driver", "reexported", "side-effect"])
})

it("rejects versions outside the SemVer grammar", () => {
  const problems = ["01.2.3", "1.2.3-alpha..1", "1.2.3+build+extra", "1.2.3-01", "1.2"].map(
    (version) =>
      tarballProblems({
        files: complete,
        manifest: publishManifest({
          manifest: { ...manifest, version },
          catalog: { effect: "4.0.0-rc.116" },
        }),
      }),
  )

  expect(problems).toEqual([
    ["version 01.2.3 is not a semantic version"],
    ["version 1.2.3-alpha..1 is not a semantic version"],
    ["version 1.2.3+build+extra is not a semantic version"],
    ["version 1.2.3-01 is not a semantic version"],
    ["version 1.2 is not a semantic version"],
  ])
})

it("does not mistake bundled command strings and documentation for imports", () => {
  const packed = publishManifest({ manifest, catalog: { effect: "4.0.0" } })

  expect(
    undeclaredImports({
      manifest: packed,
      sources: [
        '#!/usr/bin/env node\nconst command = "import"; const alphabet = "0123456789abcdef";\nconst text = `from "not-a-package"`;',
      ],
    }),
  ).toEqual([])
})

it("resolves only explicitly named release-unit workspace dependencies and checks bin targets", () => {
  const packed = publishManifest({
    manifest: { ...manifest, dependencies: { "@rikalabs/akter": "workspace:*" } },
    catalog: { effect: "4.0.0" },
    workspaceVersions: { "@rikalabs/akter": "0.1.0-alpha.7" },
  })
  expect(packed.dependencies).toEqual({ "@rikalabs/akter": "0.1.0-alpha.7" })
  expect(
    tarballProblems({ files: complete, manifest: { ...packed, bin: { akter: "./dist/main.js" } } }),
  ).toEqual(["missing dist/main.js"])
})
