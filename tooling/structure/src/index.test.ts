import { describe, expect, it } from "vitest"

import type { Exemption } from "./exemptions.ts"
import { analyze, type Finding, type TreeFile } from "./index.ts"

const file = (path: string, text = "export {}\n"): TreeFile => ({ path, text })

interface ManifestFields {
  readonly name: string
  readonly exports?: Readonly<Record<string, string | Readonly<Record<string, string>>>>
  readonly dependencies?: Readonly<Record<string, string>>
}

const manifest = (dir: string, fields: ManifestFields) =>
  file(`${dir}/package.json`, JSON.stringify(fields))

const cleanManifest = (dir: string, name: string) =>
  manifest(dir, { name, exports: { ".": "./src/index.ts" } })

const paths = (findings: ReadonlyArray<Finding>) => findings.map((finding) => finding.path)

const rules = (findings: ReadonlyArray<Finding>) => findings.map((finding) => finding.rule)

describe("package names", () => {
  it("requires @durable-actors/<basename> and names the framework @durable-actors/core", () => {
    const findings = analyze({
      files: [
        cleanManifest("packages/deployments", "@durable-actors/deployments"),
        cleanManifest("packages/durable-actors", "@durable-actors/core"),
        file("packages/deployments/src/index.ts"),
        file("packages/durable-actors/src/index.ts"),
      ],
      exemptions: [],
    })

    expect(findings).toEqual([])
  })

  it("flags an unscoped or directory-named framework and a stale @project name", () => {
    const findings = analyze({
      files: [
        cleanManifest("packages/durable-actors", "@durable-actors/durable-actors"),
        cleanManifest("packages/durable-actors", "durable-actors"),
        cleanManifest("packages/accounts", "@project/auth"),
        file("packages/durable-actors/src/index.ts"),
        file("packages/accounts/src/index.ts"),
      ],
      exemptions: [],
    })

    expect(findings.map((finding) => finding.message)).toEqual([
      "package name '@durable-actors/durable-actors' must be '@durable-actors/core'",
      "package name 'durable-actors' must be '@durable-actors/core'",
      "package name '@project/auth' must be '@durable-actors/accounts'",
    ])
  })
})

describe("dependency direction", () => {
  it("rejects app-ward dependencies and framework workspace deps, allows apps -> packages", () => {
    const findings = analyze({
      files: [
        manifest("packages/accounts", {
          name: "@durable-actors/accounts",
          exports: { ".": "./src/index.ts" },
          dependencies: { "@durable-actors/api": "workspace:*" },
        }),
        manifest("packages/durable-actors", {
          name: "@durable-actors/core",
          exports: { ".": "./src/index.ts" },
          dependencies: { "@durable-actors/postgres": "workspace:*" },
        }),
        manifest("apps/api", {
          name: "@durable-actors/api",
          exports: { ".": "./src/index.ts" },
          dependencies: {
            "@durable-actors/core": "workspace:*",
            "@durable-actors/postgres": "workspace:*",
          },
        }),
        file("packages/accounts/src/index.ts"),
        file("packages/durable-actors/src/index.ts"),
        file("apps/api/src/index.ts"),
      ],
      exemptions: [],
    })

    expect(paths(findings)).toEqual([
      "packages/accounts/package.json",
      "packages/durable-actors/package.json",
    ])
    expect(findings.every((finding) => finding.rule === "structure-rules")).toBe(true)
  })
})

describe("index.ts discipline", () => {
  it("allows index.ts only where exports name it", () => {
    const findings = analyze({
      files: [
        manifest("packages/durable-actors", {
          name: "@durable-actors/core",
          exports: {
            ".": "./src/index.ts",
            "./runtime": "./src/runtime/index.ts",
            "./client": "./src/client/index.js",
          },
        }),
        file("packages/durable-actors/src/index.ts"),
        file("packages/durable-actors/src/runtime/index.ts"),
        file("packages/durable-actors/src/client/index.ts"),
        file("packages/durable-actors/src/runtime/turn/index.ts"),
        file("packages/durable-actors/src/runtime/turn/execute.ts"),
      ],
      exemptions: [],
    })

    expect(paths(findings)).toEqual(["packages/durable-actors/src/runtime/turn/index.ts"])
    expect(findings[0]?.rule).toBe("index-not-entry")
  })

  it("rejects wildcard exports in the manifest and 'export *' in an entry", () => {
    const findings = analyze({
      files: [
        manifest("packages/foo", {
          name: "@durable-actors/foo",
          exports: { ".": "./src/index.ts", "./*": "./src/*" },
        }),
        file("packages/foo/src/index.ts", "export * from './users'\n"),
      ],
      exemptions: [],
    })

    expect(rules(findings)).toContain("wildcard-exports")
    expect(findings.length).toBe(3)
  })
})

describe("tests beside sources", () => {
  it("requires the same basename and source directory even for integration tests", () => {
    const findings = analyze({
      files: [
        cleanManifest("packages/foo", "@durable-actors/foo"),
        file("packages/foo/src/index.ts"),
        file("packages/foo/src/users.ts"),
        file("packages/foo/src/users.test.ts"),
        file("packages/foo/src/missing.test.ts"),
        file("packages/foo/test/users.test.ts"),
        file("packages/foo/test/fixture.ts"),
        file("apps/e2e/console.e2e.ts"),
        file("apps/e2e/console.test.ts"),
        file("apps/console/src/console.e2e.ts"),
      ],
      exemptions: [],
    })

    expect(paths(findings)).toEqual([
      "packages/foo/src/missing.test.ts",
      "packages/foo/test/users.test.ts",
      "packages/foo/test/fixture.ts",
      "apps/e2e/console.test.ts",
      "apps/console/src/console.e2e.ts",
    ])
    expect(findings[0]?.message).toContain("packages/foo/src/missing.ts")
  })
})

describe("leaf directory limit", () => {
  it("fails a leaf over 12 authored modules but not its parents", () => {
    const modules: Array<TreeFile> = []

    for (let index = 0; index < 13; index += 1)
      modules.push(file(`packages/foo/src/feature/m${index}.ts`))

    const findings = analyze({
      files: [
        cleanManifest("packages/foo", "@durable-actors/foo"),
        file("packages/foo/src/index.ts"),
        ...modules,
      ],
      exemptions: [],
    })

    expect(paths(findings)).toEqual(["packages/foo/src/feature"])
    expect(findings[0]?.message).toContain("13")
  })
})

describe("exemptions", () => {
  const exemptions: ReadonlyArray<Exemption> = [
    { path: "packages/ui", rule: "no-ui-package", reason: "test" },
    { path: "research", rule: "structure-rules", reason: "test" },
    { path: "packages/gone", rule: "no-ui-package", reason: "test" },
  ]

  it("suppresses matching findings", () => {
    const findings = analyze({
      files: [
        cleanManifest("packages/ui", "@durable-actors/ui"),
        file("packages/ui/src/index.ts"),
        file("research/v4/framework/Actor.ts"),
        file("research/anything/index.ts"),
      ],
      exemptions,
    })

    expect(paths(findings)).not.toContain("packages/ui")
    expect(paths(findings)).not.toContain("research/anything/index.ts")
  })

  it("reports an exemption whose path no longer exists or no longer violates", () => {
    const findings = analyze({
      files: [cleanManifest("packages/ui", "@durable-actors/ui"), file("packages/ui/src/index.ts")],
      exemptions,
    })

    const stale = findings.filter((finding) => finding.message.startsWith("stale exemption"))

    expect(stale.map((finding) => finding.path).sort()).toEqual(["packages/gone", "research"])
  })
})
