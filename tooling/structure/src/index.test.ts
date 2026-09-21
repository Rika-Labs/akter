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
  it("requires @durable-actors/<basename> and lets only the framework go unscoped", () => {
    const findings = analyze({
      files: [
        cleanManifest("packages/deployments", "@durable-actors/deployments"),
        cleanManifest("packages/durable-actors", "durable-actors"),
        file("packages/deployments/src/index.ts"),
        file("packages/durable-actors/src/index.ts"),
      ],
      exemptions: [],
    })

    expect(findings).toEqual([])
  })

  it("flags a scoped framework name and a stale @project name", () => {
    const findings = analyze({
      files: [
        cleanManifest("packages/durable-actors", "@durable-actors/durable-actors"),
        cleanManifest("packages/accounts", "@project/auth"),
        file("packages/durable-actors/src/index.ts"),
        file("packages/accounts/src/index.ts"),
      ],
      exemptions: [],
    })

    expect(findings.map((finding) => finding.message)).toEqual([
      "package name '@durable-actors/durable-actors' must be 'durable-actors'",
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
          name: "durable-actors",
          exports: { ".": "./src/index.ts" },
          dependencies: { "@durable-actors/postgres": "workspace:*" },
        }),
        manifest("apps/api", {
          name: "@durable-actors/api",
          exports: { ".": "./src/index.ts" },
          dependencies: {
            "durable-actors": "workspace:*",
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
          name: "durable-actors",
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
  it("flags test/ directories; colocated x.test.ts files pass", () => {
    const findings = analyze({
      files: [
        cleanManifest("packages/foo", "@durable-actors/foo"),
        file("packages/foo/src/index.ts"),
        file("packages/foo/src/users.ts"),
        file("packages/foo/src/users.test.ts"),
        file("packages/foo/test/extra.test.ts"),
      ],
      exemptions: [],
    })

    expect(paths(findings)).toEqual(["packages/foo/test/extra.test.ts"])
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
    { path: "apps/api/test", rule: "tests-beside-sources", reason: "test" },
    { path: "research", rule: "structure-rules", reason: "test" },
    { path: "packages/gone", rule: "no-ui-package", reason: "test" },
  ]

  it("suppresses matching findings", () => {
    const findings = analyze({
      files: [
        cleanManifest("packages/ui", "@durable-actors/ui"),
        file("packages/ui/src/index.ts"),
        file("apps/api/test/app.test.ts"),
        file("research/v4/framework/Actor.ts"),
        file("research/anything/index.ts"),
      ],
      exemptions,
    })

    expect(paths(findings)).not.toContain("packages/ui")
    expect(paths(findings)).not.toContain("apps/api/test/app.test.ts")
    expect(paths(findings)).not.toContain("research/anything/index.ts")
  })

  it("reports an exemption whose path no longer exists or no longer violates", () => {
    const findings = analyze({
      files: [
        cleanManifest("packages/ui", "@durable-actors/ui"),
        file("packages/ui/src/index.ts"),
        file("apps/api/src/app.test.ts"),
      ],
      exemptions,
    })

    const stale = findings.filter((finding) => finding.message.startsWith("stale exemption"))

    expect(stale.map((finding) => finding.path).sort()).toEqual([
      "apps/api/test",
      "packages/gone",
      "research",
    ])
  })
})
