#!/usr/bin/env bun
import { $ } from "bun"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { dirname, resolve } from "node:path"
import { combineEvidence, type Summary } from "./evidence.ts"
import { postSignoff, postStatus, readPull, replaceBody, type PullRequest } from "./github.ts"
import { acquire } from "./lock.ts"
import { loadManifest, trustedPaths, type Check, type Suite } from "./manifest.ts"
import { startDatabase, stopDatabase } from "./postgres.ts"
import { renderSection, renderSignoff, upsertSection } from "./report.ts"
import {
  baseEnv,
  createNetwork,
  freePort,
  removeAll,
  removeContainer,
  removeNetwork,
  runSteps,
  type Docker,
  type Launch,
} from "./runner.ts"
import { ensureImage, sandboxArgv, sandboxHome, type Sandbox } from "./sandbox.ts"
import { isTrusted } from "./trust.ts"
import { decide, type CheckResult } from "./verdict.ts"

const usage =
  "usage: bun run verify:local <pr|main> [--commit <sha on main>] [--post --agent <name>] [--only id,id] [--runs <1-25>] [--keep] [--sandbox] [--trust-reviewed <head sha>] [--inject-failure id]"

const args = Bun.argv.slice(2)
const value = (flag: string) => {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}
const onMain = args[0] === "main"
const pr = onMain ? 0 : Number(args[0])
if (!onMain && (!Number.isInteger(pr) || pr <= 0)) throw new Error(usage)
const post = args.includes("--post")
const keep = args.includes("--keep")
const forceSandbox = args.includes("--sandbox")
const reviewed = value("--trust-reviewed")
const commit = value("--commit")
const agent = value("--agent") ?? process.env.VERIFY_AGENT
const onlyList = value("--only")
const injected = value("--inject-failure")
const runs = value("--runs") ?? "10"
if (post && !agent)
  throw new Error(`--post needs --agent <name of the agent or thread running this>\n${usage}`)
if (commit !== undefined && !onMain) throw new Error("--commit belongs to a run on main")
if (forceSandbox && reviewed !== undefined)
  throw new Error("--sandbox and --trust-reviewed contradict each other")

const toolRoot = resolve(dirname(import.meta.dir), "../..")
const {
  manifest,
  text: manifestText,
  digest,
} = loadManifest(`${toolRoot}/tooling/local-verify/manifest.json`)
const required = new Set(manifest.checks.map((check) => check.id))
const suites = new Set(manifest.suites.map((suite) => suite.id))
const only = onlyList === undefined ? undefined : new Set(onlyList.split(","))
for (const id of [...(only ?? []), ...(injected === undefined ? [] : [injected])])
  if (!required.has(id) && !suites.has(id))
    throw new Error(`unknown check ${id}; the manifest has ${[...required, ...suites].join(", ")}`)
const selectedSuites = manifest.suites.filter((suite) => only?.has(suite.id))
if (post && selectedSuites.length > 0)
  throw new Error(
    `Optional suites never post statuses (${selectedSuites.map((suite) => suite.id).join(", ")}); they are not required per pull request`,
  )
const selectedChecks = manifest.checks.filter((check) => only === undefined || only.has(check.id))

const repository = manifest.repository
const verifyHome = process.env.AKTER_VERIFY_HOME ?? `${homedir()}/.capy/work/akter-verify`
const git = (...rest: string[]) => $`git -C ${toolRoot} ${rest}`.quiet()
const text = async (...rest: string[]) => (await git(...rest)).stdout.toString().trim()
const succeeds = async (...rest: string[]) => (await git(...rest).nothrow()).exitCode === 0

const release = await acquire(`verify:local ${onMain ? "main" : pr}`)

const view: PullRequest = onMain
  ? {
      headRefOid: "",
      headRefName: "main",
      baseRefName: "main",
      author: { login: manifest.trustedAuthors[0] ?? "" },
      isCrossRepository: false,
      state: "OPEN",
      body: "",
    }
  : await readPull(repository, pr)
if (post && view.state !== "OPEN")
  throw new Error(`#${pr} is ${view.state}; only an open pull request can be signed off`)

const remote = await text("remote", "get-url", "origin")
if (!remote.toLowerCase().includes(repository.toLowerCase()))
  throw new Error(`origin of ${toolRoot} is ${remote}, not ${repository}`)

await git(
  "fetch",
  "-q",
  "origin",
  ...(onMain ? [] : [`+refs/pull/${pr}/head:refs/remotes/pr/${pr}`]),
  `+refs/heads/main:refs/remotes/origin/main`,
  `+refs/heads/${view.baseRefName}:refs/remotes/origin/${view.baseRefName}`,
)
const sha = onMain
  ? await text("rev-parse", "--verify", `${commit ?? "refs/remotes/origin/main"}^{commit}`)
  : view.headRefOid
if (onMain && !(await succeeds("merge-base", "--is-ancestor", sha, "refs/remotes/origin/main")))
  throw new Error(`${sha} is not on origin/main`)
if (!onMain) {
  const fetched = await text("rev-parse", `refs/remotes/pr/${pr}`)
  if (fetched !== sha)
    throw new Error(`fetched head ${fetched} != ${sha}; the pull request moved, run again`)
}

/**
 * The runner, manifest and trusted policy scripts come from the checkout that runs this command,
 * not from the pull request, so a pull request cannot loosen its own checks. A sign-off therefore
 * requires that their committed content equals main's, or the pull request head's own when the
 * pull request changes it (and the sign-off says so).
 */
const idsAt = async (rev: string) =>
  (
    await Promise.all(
      trustedPaths.map(async (path) =>
        (await succeeds("cat-file", "-e", `${rev}:${path}`))
          ? text("rev-parse", "--verify", `${rev}:${path}`)
          : "",
      ),
    )
  ).join(",")
const complete = (ids: string) => ids.split(",").every((id) => id !== "")
const toolIds = await idsAt("HEAD")
const dirty = (await text("status", "--porcelain", "--", ...trustedPaths)) !== ""
const tooling =
  complete(toolIds) && toolIds === (await idsAt("refs/remotes/origin/main"))
    ? `tooling identical to origin/main (${createHash("sha256").update(toolIds).digest("hex").slice(0, 12)})`
    : complete(toolIds) && toolIds === (await idsAt(sha))
      ? `tooling from this pull request's head (${createHash("sha256").update(toolIds).digest("hex").slice(0, 12)}), which changes it; a maintainer must review that diff`
      : undefined
if (post && (dirty || tooling === undefined))
  throw new Error(
    "Refusing to sign off: run from a checkout whose committed tooling/local-verify, .github/src/check-branch.ts and .github/src/policy.ts match origin/main or this pull request's head, with no uncommitted changes there",
  )
const toolDigest = createHash("sha256").update(manifestText).update(toolIds).digest("hex")

const trusted = isTrusted(
  { author: view.author.login, crossRepository: view.isCrossRepository },
  manifest.trustedAuthors,
)
if (reviewed !== undefined && reviewed !== sha)
  throw new Error(
    `--trust-reviewed names ${reviewed}, but the head is ${sha}; review this head first`,
  )
const sandboxed = forceSandbox || (!trusted && reviewed === undefined)
const isolation = sandboxed
  ? "Docker sandbox: only the checkout is mounted, with no home directory, secrets, SSH agent, Docker socket or gh token; checks that need the host Docker daemon do not run, so their status stays failing until a maintainer reviews the head and runs it with --trust-reviewed"
  : trusted
    ? "host: the author and head repository are trusted"
    : `host, after a maintainer reviewed head ${sha} (--trust-reviewed)`

const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const label = onMain ? "main" : String(pr)
const out = `${verifyHome}/runs/${label}-${sha.slice(0, 12)}-${stamp}`
const wt = `${verifyHome}/worktrees/wt-${label}-${sha.slice(0, 12)}-${process.pid}`
mkdirSync(out, { recursive: true })
console.log(
  `${onMain ? "main" : `#${pr}`} ${view.headRefName} @ ${sha} (${view.state}) by ${view.author.login} -> ${out}\nisolation: ${isolation}`,
)

const env = baseEnv()
const docker: Docker = { env, containers: [], networks: [] }
const dockerCli: NodeJS.ProcessEnv = {
  PATH: env.PATH,
  HOME: env.HOME,
  DOCKER_HOST: env.DOCKER_HOST,
}
const cleanup = async () => {
  await removeAll(docker)
  if (keep) return
  if (sandboxed) rmSync(wt, { recursive: true, force: true })
  else await git("worktree", "remove", "--force", wt).nothrow()
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void cleanup().then(() => process.exit(signal === "SIGINT" ? 130 : 143)))

const results: Record<string, CheckResult> = {}
const suiteResults: Record<string, CheckResult> = {}
const timeout = (minutes: number) => minutes * 60000

try {
  if (sandboxed) {
    mkdirSync(wt, { recursive: true })
    const inside = (...rest: string[]) =>
      $`git -c core.hooksPath=/dev/null -C ${wt} ${rest}`.quiet()
    await inside("init", "-q")
    await inside(
      "fetch",
      "-q",
      "--no-tags",
      toolRoot,
      ...(onMain ? [] : [`+refs/remotes/pr/${pr}:refs/remotes/pr/${pr}`]),
      `+refs/remotes/origin/main:refs/remotes/origin/main`,
      `+refs/remotes/origin/${view.baseRefName}:refs/remotes/origin/${view.baseRefName}`,
    )
    await inside("checkout", "-q", "--detach", sha)
    mkdirSync(`${wt}${sandboxHome.slice("/work".length)}`, { recursive: true })
  } else {
    await $`git -C ${toolRoot} worktree prune`.quiet().nothrow()
    await $`git -C ${toolRoot} worktree add -q --detach ${wt} ${sha}`
  }
  const checkedOut = (await $`git -C ${wt} rev-parse HEAD`.quiet().text()).trim()
  if (checkedOut !== sha) throw new Error(`checked out ${checkedOut}, not ${sha}`)

  const eventFile = `${out}/event.json`
  writeFileSync(
    eventFile,
    JSON.stringify({
      pull_request: {
        base: { ref: view.baseRefName },
        head: { ref: view.headRefName },
        user: { login: view.author.login },
      },
    }),
  )
  const concurrency = process.env.LOCAL_VERIFY_CONCURRENCY ?? "6"
  const counterFile = `${verifyHome}/suite-run-number`
  const runNumber = (existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) : 0) + 1
  if (selectedSuites.length > 0) writeFileSync(counterFile, String(runNumber))
  const portable = {
    VERIFY_CONCURRENCY: concurrency,
    VERIFY_BASE: view.baseRefName,
    VERIFY_PR: label,
    VERIFY_SHA: sha,
    VERIFY_RUNS: runs,
    VERIFY_RUN_NUMBER: String(runNumber),
    TURBO_FORCE: "1",
  }
  const hostShared = { ...portable, VERIFY_TOOL_ROOT: toolRoot, GITHUB_EVENT_PATH: eventFile }

  const sandbox = async (name: string): Promise<Sandbox> => {
    const network = `${name}-net`
    await createNetwork(docker, network)
    return {
      env: dockerCli,
      image: await ensureImage(dockerCli),
      checkout: wt,
      network,
      uid: userInfo().uid,
      gid: userInfo().gid,
    }
  }
  const sandboxLaunch =
    (box: Sandbox, name: string, environment: Record<string, string>) =>
    (step: { run: string; env?: Record<string, string> }, index: number): Launch => {
      const container = `${name}-s${index}`
      docker.containers.push(container)
      return {
        argv: sandboxArgv(box, container, { ...environment, ...step.env }, step.run),
        env: dockerCli,
        stop: () => removeContainer(docker, container),
      }
    }

  const setupName = `akter-verify-${label}-setup-${process.pid}`
  const setupBox = sandboxed ? await sandbox(setupName) : undefined
  const setup = await runSteps([{ name: manifest.setup.name, run: manifest.setup.run }], {
    cwd: wt,
    env: { ...env, ...hostShared },
    timeoutMs: timeout(manifest.setup.timeoutMinutes),
    log: `${out}/setup.log`,
    logs: out,
    launch: setupBox && sandboxLaunch(setupBox, setupName, portable),
  })
  if (setupBox) await removeNetwork(docker, setupBox.network)
  console.log(`setup: ${setup.result} (${setup.seconds}s)`)

  const injectedStep = {
    name: "Injected failure (test aid)",
    run: "echo 'verify:local --inject-failure: this check fails on purpose' >&2; false",
  }
  const runUnit = async (unit: Check | Suite): Promise<CheckResult | undefined> => {
    const where = unit.runIn === "tool" ? "tool" : sandboxed ? "sandbox" : "host"
    if (setup.result !== "pass" && unit.runIn !== "tool")
      return { result: "fail", seconds: 0, failedStep: "setup", logs: out, where }
    if (unit.needsDocker === true && sandboxed) {
      console.log(
        `${unit.id}: not run; it needs the host Docker daemon and this head runs in the sandbox`,
      )
      return undefined
    }
    const name = `akter-verify-${label}-${unit.id}-${process.pid}`
    const inSandbox = where === "sandbox"
    const unitEnv: Record<string, string> = {}
    for (const port of unit.freePorts ?? []) unitEnv[port] = freePort()
    const applicable = unit.steps.filter(
      (step) => step.when === undefined || step.when === (onMain ? "commit" : "pull"),
    )
    const steps = unit.id === injected ? [injectedStep, ...applicable] : applicable
    const groups = unit.postgres?.scope === "step" ? steps.map((step) => [step]) : [steps]
    const started = Date.now()
    let result: Omit<CheckResult, "where"> | undefined
    for (const [round, group] of groups.entries()) {
      const prefix = groups.length === 1 ? name : `${name}-${round}`
      const box = inSandbox ? await sandbox(prefix) : undefined
      const needsNetwork = !inSandbox && unit.postgres !== undefined
      if (needsNetwork) await createNetwork(docker, `${prefix}-net`)
      const database = unit.postgres
        ? await startDatabase(
            docker,
            `${prefix}-pg`,
            `${prefix}-net`,
            unit.postgres,
            unit.postgres.replica === true,
          )
        : undefined
      const urls = inSandbox ? database?.network : database?.host
      const placeholders = (raw: string) =>
        raw
          .replaceAll("{{postgres.url}}", urls?.url ?? "")
          .replaceAll("{{replica.url}}", urls?.replicaUrl ?? "")
      const groupEnv = {
        ...unitEnv,
        ...Object.fromEntries(
          Object.entries(unit.env ?? {}).map(([key, raw]) => [key, placeholders(raw)]),
        ),
      }
      const ran = await runSteps(group, {
        cwd: unit.runIn === "tool" ? toolRoot : wt,
        env: { ...env, ...hostShared, ...groupEnv },
        timeoutMs: Math.max(timeout(unit.timeoutMinutes) - (Date.now() - started), 1000),
        log: `${out}/${unit.id}.log`,
        logs: out,
        launch: box && sandboxLaunch(box, prefix, { ...portable, ...groupEnv }),
      })
      if (database) await stopDatabase(docker, database)
      if (box) await removeNetwork(docker, box.network)
      if (needsNetwork) await removeNetwork(docker, `${prefix}-net`)
      result = ran
      if (ran.result === "fail") break
    }
    if (result === undefined) throw new Error(`${unit.id} has no steps`)
    const final: CheckResult = {
      ...result,
      seconds: Math.round((Date.now() - started) / 1000),
      where,
    }
    console.log(
      `${unit.id}: ${final.result} (${final.seconds}s, ${where})${final.failedStep ? ` at "${final.failedStep}"` : ""}`,
    )
    return final
  }

  for (const check of selectedChecks) {
    const result = await runUnit(check)
    if (result) results[check.id] = result
  }
  for (const suite of selectedSuites) {
    const result = await runUnit(suite)
    if (result) suiteResults[suite.id] = result
  }
} finally {
  await cleanup()
}

const earlier = await Promise.all(
  (
    await Array.fromAsync(
      new Bun.Glob(`${label}-${sha.slice(0, 12)}-*/summary.json`).scan({
        cwd: `${verifyHome}/runs`,
      }),
    )
  )
    .sort()
    .map(
      async (file) => JSON.parse(await Bun.file(`${verifyHome}/runs/${file}`).text()) as Summary,
    ),
)
const combined = combineEvidence(earlier, sha, toolDigest, results)

const verdict = decide(manifest, combined)
const provenance = {
  sha,
  agent: agent ?? "unattributed local run",
  at: new Date().toISOString(),
  logs: out,
  manifestDigest: digest,
  tooling: tooling ?? "tooling not committed",
  isolation,
  cache: "uncached: TURBO_FORCE=1, no task result was replayed",
}
writeFileSync(
  `${out}/summary.json`,
  JSON.stringify(
    {
      target: label,
      sha,
      branch: view.headRefName,
      author: view.author.login,
      isolation,
      cached: false,
      manifestDigest: digest,
      toolDigest,
      tooling,
      results,
      suiteResults,
      combined,
      statuses: verdict.statuses,
      signedOff: verdict.signedOff,
      logs: out,
    },
    null,
    2,
  ),
)
console.log(
  JSON.stringify(
    {
      sha,
      signedOff: verdict.signedOff,
      checks: verdict.checks.map((check) => `${check.id}:${check.outcome}`),
      suites: Object.entries(suiteResults).map(([id, result]) => `${id}:${result.result}`),
      statuses: verdict.statuses,
    },
    null,
    2,
  ),
)

if (post) {
  const moved = !onMain && (await readPull(repository, pr)).headRefOid !== sha
  const section = renderSection(verdict, provenance)
  const writesPull = !onMain && !moved
  if (moved)
    console.log(
      `#${pr} moved past ${sha} during the run: setting statuses on ${sha} only, with no body section or sign-off comment`,
    )
  if (writesPull && verdict.signedOff) {
    await replaceBody(repository, pr, upsertSection((await readPull(repository, pr)).body, section))
    await postSignoff(repository, pr, sha, renderSignoff(verdict, provenance))
  }
  for (const status of verdict.statuses) await postStatus(repository, sha, status)
  if (writesPull && !verdict.signedOff)
    await replaceBody(repository, pr, upsertSection((await readPull(repository, pr)).body, section))
  console.log(
    `posted ${verdict.statuses.map((status) => `${status.context}=${status.state}`).join(" ")} on ${sha}${verdict.signedOff && writesPull ? "; body section and sign-off comment written" : ""}`,
  )
}
release()
const ran = [...Object.values(results), ...Object.values(suiteResults)]
process.exit(
  (only ? ran.length > 0 && ran.every((result) => result.result === "pass") : verdict.signedOff)
    ? 0
    : 1,
)
