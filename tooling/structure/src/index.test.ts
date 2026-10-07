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
  it("allows the published CLI name only in apps/cli", () => {
    expect(
      analyze({
        files: [manifest("apps/cli", { name: "akter" })],
        exemptions: [],
      }),
    ).toEqual([])
    expect(
      analyze({
        files: [manifest("packages/other", { name: "akter" })],
        exemptions: [],
      }).map((finding) => finding.message),
    ).toEqual(["package name 'akter' must be '@akter/other'"])
  })
  it("requires @akter/<basename> and names the framework @rikalabs/akter", () => {
    const findings = analyze({
      files: [
        cleanManifest("packages/deployments", "@akter/deployments"),
        cleanManifest("packages/akter", "@rikalabs/akter"),
        file("packages/deployments/src/index.ts"),
        file("packages/akter/src/index.ts"),
      ],
      exemptions: [],
    })

    expect(findings).toEqual([])
  })

  it("flags an unscoped or directory-named framework and a stale @project name", () => {
    const findings = analyze({
      files: [
        cleanManifest("packages/akter", "@akter/akter"),
        cleanManifest("packages/akter", "akter"),
        cleanManifest("packages/accounts", "@project/auth"),
        file("packages/akter/src/index.ts"),
        file("packages/accounts/src/index.ts"),
      ],
      exemptions: [],
    })

    expect(findings.map((finding) => finding.message)).toEqual([
      "package name '@akter/akter' must be '@rikalabs/akter'",
      "package name 'akter' must be '@rikalabs/akter'",
      "package name '@project/auth' must be '@akter/accounts'",
    ])
  })
})

describe("dependency direction", () => {
  it("rejects a library depending on the published CLI", () => {
    expect(analyze({
      files: [manifest("packages/other", { name: "@akter/other", dependencies: { akter: "0.1.0-alpha.1" } })],
      exemptions: [],
    }).map((finding) => finding.message)).toEqual(["depends on app package 'akter'; dependency direction is apps -> packages, never app-ward"])
  })
  it("rejects app-ward dependencies and framework workspace deps, allows apps -> packages", () => {
    const findings = analyze({
      files: [
        manifest("packages/accounts", {
          name: "@akter/accounts",
          exports: { ".": "./src/index.ts" },
          dependencies: { "@akter/api": "workspace:*" },
        }),
        manifest("packages/akter", {
          name: "@rikalabs/akter",
          exports: { ".": "./src/index.ts" },
          dependencies: { "@akter/postgres": "workspace:*" },
        }),
        manifest("apps/api", {
          name: "@akter/api",
          exports: { ".": "./src/index.ts" },
          dependencies: {
            "@rikalabs/akter": "workspace:*",
            "@akter/postgres": "workspace:*",
          },
        }),
        file("packages/accounts/src/index.ts"),
        file("packages/akter/src/index.ts"),
        file("apps/api/src/index.ts"),
      ],
      exemptions: [],
    })

    expect(paths(findings)).toEqual([
      "packages/accounts/package.json",
      "packages/akter/package.json",
    ])
    expect(findings.every((finding) => finding.rule === "structure-rules")).toBe(true)
  })
})

describe("index.ts discipline", () => {
  it("allows index.ts only where exports name it", () => {
    const findings = analyze({
      files: [
        manifest("packages/akter", {
          name: "@rikalabs/akter",
          exports: {
            ".": "./src/index.ts",
            "./runtime": "./src/runtime/index.ts",
            "./client": "./src/client/index.js",
          },
        }),
        file("packages/akter/src/index.ts"),
        file("packages/akter/src/runtime/index.ts"),
        file("packages/akter/src/client/index.ts"),
        file("packages/akter/src/runtime/turn/index.ts"),
        file("packages/akter/src/runtime/turn/execute.ts"),
      ],
      exemptions: [],
    })

    expect(paths(findings)).toEqual(["packages/akter/src/runtime/turn/index.ts"])
    expect(findings[0]?.rule).toBe("index-not-entry")
  })

  it("rejects wildcard exports in the manifest and 'export *' in an entry", () => {
    const findings = analyze({
      files: [
        manifest("packages/foo", {
          name: "@akter/foo",
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
        cleanManifest("packages/foo", "@akter/foo"),
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

describe("exemptions", () => {
  const exemptions: ReadonlyArray<Exemption> = [
    { path: "tooling/vendored/index.ts", rule: "index-not-entry", reason: "test" },
    { path: "research", rule: "structure-rules", reason: "test" },
    { path: "packages/gone", rule: "index-not-entry", reason: "test" },
    { path: "packages/ui", rule: "index-not-entry", reason: "test" },
  ]

  it("suppresses matching findings", () => {
    const findings = analyze({
      files: [
        cleanManifest("packages/ui", "@akter/ui"),
        file("packages/ui/src/index.ts"),
        file("tooling/vendored/index.ts"),
        file("research/v4/framework/Actor.ts"),
        file("research/anything/index.ts"),
      ],
      exemptions,
    })

    expect(findings.filter((finding) => !finding.message.startsWith("stale exemption"))).toEqual([])
  })

  it("reports an exemption whose path no longer exists or no longer violates", () => {
    const findings = analyze({
      files: [cleanManifest("packages/ui", "@akter/ui"), file("packages/ui/src/index.ts")],
      exemptions,
    })

    expect(
      findings
        .map((finding) => `${finding.path}: ${finding.message}`)
        .toSorted()
        .map((line) => line.replace(/ — remove the entry$/, "")),
    ).toEqual([
      "packages/gone: stale exemption for rule 'index-not-entry': the path no longer exists",
      "packages/ui: stale exemption for rule 'index-not-entry': the path no longer violates it",
      "research: stale exemption for rule 'structure-rules': the path no longer exists",
      "tooling/vendored/index.ts: stale exemption for rule 'index-not-entry': the path no longer exists",
    ])
  })
})
