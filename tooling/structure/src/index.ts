import { BunServices } from "@effect/platform-bun"
import {
  Console,
  Effect,
  Exit,
  FileSystem,
  ManagedRuntime,
  Predicate,
  Schema,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { type Exemption, exemptions } from "./exemptions.ts"

const SOURCE_FILE = /\.[cm]?[jt]sx?$/

const INDEX_FILE = /(?:^|\/)index\.[cm]?[jt]sx?$/

const TEST_DIR = /(?:^|\/)tests?\//

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/

const E2E_FILE = /\.e2e\.[cm]?[jt]sx?$/

const APP_PACKAGE = /^@durable-actors\/(api|console|edge|cli)$/

const WORKSPACE_PACKAGE = /^@durable-actors\//

/** A tracked file's repository-relative path and its text. */
export interface TreeFile {
  readonly path: string
  readonly text: string
}

/** One structure violation at `path` for `rule`. */
export interface Finding {
  readonly path: string
  readonly rule: Exemption["rule"]
  readonly message: string
}

const Manifest = Schema.Struct({
  name: Schema.optional(Schema.String),
  exports: Schema.optional(Schema.Unknown),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

const ManifestFromJson = Schema.fromJsonString(Manifest)

type Manifest = typeof Manifest.Type

const isString = Predicate.isString

interface ExportValueRecord {
  readonly [key: string]: ExportValue
}

type ExportValue = string | ReadonlyArray<ExportValue> | ExportValueRecord

const isExportValue = (value: unknown): value is ExportValue => {
  if (Predicate.isString(value)) return true

  if (Array.isArray(value)) return value.every(isExportValue)

  if (Predicate.isObject(value)) return Object.values(value).every(isExportValue)

  return false
}

const exportTargets = (value: ExportValue, targets: Array<string>): void => {
  if (Predicate.isString(value)) {
    targets.push(value)

    return
  }

  if (Array.isArray(value)) {
    for (const item of value) exportTargets(item, targets)

    return
  }

  for (const item of Object.values(value)) exportTargets(item, targets)
}

const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`)

const findExemption = (input: {
  readonly exemptions: ReadonlyArray<Exemption>
  readonly finding: Finding
}) =>
  input.exemptions.find(
    (exemption) =>
      exemption.rule === input.finding.rule && isUnder(input.finding.path, exemption.path),
  )

const exemptedWhole = (input: {
  readonly exemptions: ReadonlyArray<Exemption>
  readonly path: string
}) =>
  input.exemptions.some(
    (exemption) => exemption.rule === "structure-rules" && isUnder(input.path, exemption.path),
  )

const checkManifests = (input: {
  readonly files: ReadonlyArray<TreeFile>
  readonly exemptions: ReadonlyArray<Exemption>
  readonly findings: Array<Finding>
}) => {
  const entryFiles = new Set<string>()

  for (const file of input.files) {
    if (!file.path.endsWith("package.json")) continue

    if (exemptedWhole({ exemptions: input.exemptions, path: file.path })) continue

    const dir = file.path.slice(0, -"package.json".length)
    const top = dir.split("/")[0] ?? ""
    const basename = dir.split("/").filter(Boolean).at(-1) ?? ""
    const parsed = Schema.decodeExit(ManifestFromJson)(file.text)

    if (Exit.isFailure(parsed)) {
      input.findings.push({
        path: file.path,
        rule: "structure-rules",
        message: "unparseable package.json",
      })
      continue
    }

    const manifest = parsed.value

    const expected =
      basename === "durable-actors"
        ? "@durable-actors/core"
        : `@durable-actors/${dir === "" ? "monorepo" : basename}`

    if (manifest.name !== expected)
      input.findings.push({
        path: file.path,
        rule: "structure-rules",
        message: `package name '${manifest.name ?? "(missing)"}' must be '${expected}'`,
      })

    const deps = { ...manifest.dependencies, ...manifest.devDependencies }

    for (const dep of Object.keys(deps)) {
      if (top !== "apps" && APP_PACKAGE.test(dep))
        input.findings.push({
          path: file.path,
          rule: "structure-rules",
          message: `depends on app package '${dep}'; dependency direction is apps -> packages, never app-ward`,
        })

      if (basename === "durable-actors" && WORKSPACE_PACKAGE.test(dep))
        input.findings.push({
          path: file.path,
          rule: "structure-rules",
          message: `the framework package must not depend on workspace package '${dep}'`,
        })
    }

    const exports = manifest.exports

    if (isString(exports)) {
      entryFiles.add(`${dir}${exports.replace(/^\.\//, "").replace(/\.js$/, ".ts")}`)
    } else if (Predicate.isObject(exports)) {
      for (const [key, target] of Object.entries(exports)) {
        if (key.includes("*"))
          input.findings.push({
            path: file.path,
            rule: "wildcard-exports",
            message: `exports key '${key}' is a wildcard; name each subpath entry explicitly`,
          })

        if (!isExportValue(target)) continue

        const targets: Array<string> = []
        exportTargets(target, targets)

        for (const targetFile of targets) {
          if (targetFile.includes("*"))
            input.findings.push({
              path: file.path,
              rule: "wildcard-exports",
              message: `exports target '${targetFile}' is a wildcard; name the real file`,
            })
          entryFiles.add(`${dir}${targetFile.replace(/^\.\//, "").replace(/\.js$/, ".ts")}`)
        }
      }
    }
  }

  return entryFiles
}

const checkIndexFiles = (input: {
  readonly files: ReadonlyArray<TreeFile>
  readonly exemptions: ReadonlyArray<Exemption>
  readonly entryFiles: ReadonlySet<string>
  readonly findings: Array<Finding>
}) => {
  for (const file of input.files) {
    if (!INDEX_FILE.test(file.path)) continue

    if (exemptedWhole({ exemptions: input.exemptions, path: file.path })) continue

    if (file.path.startsWith(".amp/plugins/")) continue

    if (!input.entryFiles.has(file.path)) {
      input.findings.push({
        path: file.path,
        rule: "index-not-entry",
        message:
          "index.ts is only allowed as a package or subpath entry named by package.json exports",
      })
      continue
    }

    if (/^\s*export\s+\*/m.test(file.text))
      input.findings.push({
        path: file.path,
        rule: "wildcard-exports",
        message: "entry index.ts must name real files; 'export *' is banned",
      })
  }
}

const checkTests = (input: {
  readonly files: ReadonlyArray<TreeFile>
  readonly exemptions: ReadonlyArray<Exemption>
  readonly findings: Array<Finding>
}) => {
  const paths = new Set(input.files.map((file) => file.path))

  for (const file of input.files) {
    if (!SOURCE_FILE.test(file.path)) continue

    if (exemptedWhole({ exemptions: input.exemptions, path: file.path })) continue

    if (file.path.startsWith("apps/e2e/")) {
      if (TEST_FILE.test(file.path))
        input.findings.push({
          path: file.path,
          rule: "tests-beside-sources",
          message: "only browser *.e2e.ts specs belong in apps/e2e",
        })
      continue
    }

    if (E2E_FILE.test(file.path)) {
      input.findings.push({
        path: file.path,
        rule: "tests-beside-sources",
        message: "browser E2E specs belong in apps/e2e",
      })
      continue
    }

    if (TEST_DIR.test(file.path) || (TEST_FILE.test(file.path) && !file.path.includes("/src/"))) {
      input.findings.push({
        path: file.path,
        rule: "tests-beside-sources",
        message: "only browser E2E lives outside src; colocate x.test.ts beside src/x.ts",
      })
      continue
    }

    if (!TEST_FILE.test(file.path)) continue

    const source = file.path.replace(/\.test(?=\.[cm]?[jt]sx?$)/, "")

    if (!paths.has(source))
      input.findings.push({
        path: file.path,
        rule: "tests-beside-sources",
        message: `test must match its source file at ${source}`,
      })
  }
}

const checkStaleExemptions = (input: {
  readonly files: ReadonlyArray<TreeFile>
  readonly exemptions: ReadonlyArray<Exemption>
  readonly findings: ReadonlyArray<Finding>
  readonly report: Array<Finding>
}) => {
  for (const exemption of input.exemptions) {
    const pathExists = input.files.some((file) => isUnder(file.path, exemption.path))

    const suppresses = input.findings.some(
      (finding) => findExemption({ exemptions: input.exemptions, finding }) === exemption,
    )

    const blanket = exemption.rule === "structure-rules"

    if (!pathExists || (!suppresses && !blanket))
      input.report.push({
        path: exemption.path,
        rule: "structure-rules",
        message: `stale exemption for rule '${exemption.rule}': the path ${pathExists ? "no longer violates it" : "no longer exists"} — remove the entry`,
      })
  }
}

/**
 * Checks the file tree against the structure rules and returns the findings
 * not covered by an exemption, plus a finding for each stale exemption.
 */
export const analyze = (input: {
  readonly files: ReadonlyArray<TreeFile>
  readonly exemptions: ReadonlyArray<Exemption>
}): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = []

  const entryFiles = checkManifests({ files: input.files, exemptions: input.exemptions, findings })
  checkIndexFiles({ files: input.files, exemptions: input.exemptions, entryFiles, findings })
  checkTests({ files: input.files, exemptions: input.exemptions, findings })

  const report = findings.filter(
    (finding) => findExemption({ exemptions: input.exemptions, finding }) === undefined,
  )

  checkStaleExemptions({
    files: input.files,
    exemptions: input.exemptions,
    findings,
    report,
  })

  return report
}

class StructureError extends Schema.TaggedError<StructureError>()("StructureError", {
  count: Schema.Int,
}) {}

/**
 * Checks the repository's tracked and untracked files; fails with a
 * `StructureError` counting the findings, which it prints.
 */
export const check = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const command = ChildProcess.make("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ])

  const handle = yield* spawner.spawn(command)
  const output = yield* handle.stdout.pipe(Stream.decodeText, Stream.mkString)

  if ((yield* handle.exitCode) !== 0)
    return yield* Effect.die(new Error("Cannot enumerate repository files with Git"))

  const files: Array<TreeFile> = []

  for (const path of new Set(output.split("\0").filter(Boolean))) {
    if (!(yield* fs.exists(path))) continue
    const info = yield* fs.stat(path)

    if (info.type !== "File") continue
    files.push({ path, text: yield* fs.readFileString(path) })
  }

  const findings = analyze({ files, exemptions })

  for (const finding of findings)
    yield* Console.error(`${finding.path}: [${finding.rule}] ${finding.message}`)

  if (findings.length !== 0) return yield* StructureError.make({ count: findings.length })

  yield* Console.log("Repository tree satisfies the structure contract.")
})

if (import.meta.main) {
  const runtime = ManagedRuntime.make(BunServices.layer)
  await runtime.runPromise(check.pipe(Effect.scoped)).finally(() => runtime.dispose())
}
