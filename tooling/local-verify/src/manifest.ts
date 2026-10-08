import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { Schema } from "effect"

const Env = Schema.Record(Schema.String, Schema.String)

const Step = Schema.Struct({
  name: Schema.String,
  run: Schema.String,
  env: Schema.optionalKey(Env),
  when: Schema.optionalKey(Schema.Literals(["pull", "commit"])),
})

const Postgres = Schema.Struct({
  image: Schema.String,
  env: Env,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  replica: Schema.optionalKey(Schema.Boolean),
  scope: Schema.optionalKey(Schema.Literals(["check", "step"])),
})

const unit = {
  id: Schema.String,
  description: Schema.String,
  timeoutMinutes: Schema.Int,
  env: Schema.optionalKey(Env),
  freePorts: Schema.optionalKey(Schema.Array(Schema.String)),
  postgres: Schema.optionalKey(Postgres),
  runIn: Schema.optionalKey(Schema.Literal("tool")),
  needsDocker: Schema.optionalKey(Schema.Boolean),
  steps: Schema.Array(Step),
}

const Check = Schema.Struct(unit)

const Suite = Schema.Struct({ ...unit, cadence: Schema.String })

const Manifest = Schema.Struct({
  repository: Schema.String,
  trustedAuthors: Schema.Array(Schema.String),
  setup: Schema.Struct({ name: Schema.String, run: Schema.String, timeoutMinutes: Schema.Int }),
  checks: Schema.Array(Check),
  statuses: Schema.Array(
    Schema.Struct({ context: Schema.String, checks: Schema.Array(Schema.String) }),
  ),
  suites: Schema.Array(Suite),
})

/**
 * The paths whose committed content decides what a verification run does. They run from the tool
 * checkout, never from the pull request, so a sign-off requires them to match main or the head.
 */
export const trustedPaths = [
  "tooling/local-verify",
  ".github/src/check-branch.ts",
  ".github/src/policy.ts",
]

export type Manifest = typeof Manifest.Type
export type ManifestInput = typeof Manifest.Encoded
export type Check = typeof Check.Type
export type Suite = typeof Suite.Type
export type Step = typeof Step.Type

/**
 * Decodes the checked-in manifest and rejects one that could sign off less than it lists: duplicate
 * ids, a check no status requires, a status that names an unknown or repeated check, and a check
 * with no steps would each let a pull request go green without a required check having run. An
 * optional suite is never required by a status, so it cannot share an id with a check, and a check
 * that runs from the trusted tool checkout cannot also ask for services or the host Docker daemon.
 */
export function parseManifest(json: string): Manifest {
  const manifest = Schema.decodeSync(Schema.fromJsonString(Manifest))(json)
  const ids = manifest.checks.map((check) => check.id)
  const suiteIds = manifest.suites.map((suite) => suite.id)
  const problems: string[] = []
  if (ids.length === 0) problems.push("the manifest lists no checks")
  if (new Set([...ids, ...suiteIds]).size !== ids.length + suiteIds.length)
    problems.push("check and suite ids must be unique")
  for (const unitOfWork of [...manifest.checks, ...manifest.suites]) {
    if (unitOfWork.steps.length === 0) problems.push(`${unitOfWork.id} has no steps`)
    if (
      unitOfWork.runIn === "tool" &&
      (unitOfWork.postgres !== undefined || unitOfWork.needsDocker === true)
    )
      problems.push(`${unitOfWork.id} runs in the tool checkout and cannot use services or Docker`)
  }
  const required = manifest.statuses.flatMap((status) => status.checks)
  for (const name of required)
    if (!ids.includes(name)) problems.push(`a status requires unknown check ${name}`)
  for (const id of ids) {
    const count = required.filter((name) => name === id).length
    if (count !== 1)
      problems.push(`check ${id} must be required by exactly one status, found ${count}`)
  }
  if (new Set(manifest.statuses.map((status) => status.context)).size !== manifest.statuses.length)
    problems.push("status contexts must be unique")
  if (problems.length > 0)
    throw new Error(`Invalid local verification manifest: ${problems.join("; ")}`)
  return manifest
}

export function loadManifest(file: string) {
  const text = readFileSync(file, "utf8")
  return {
    manifest: parseManifest(text),
    text,
    digest: createHash("sha256").update(text).digest("hex"),
  }
}
