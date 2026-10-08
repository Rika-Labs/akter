import { $ } from "bun"
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import type { Step } from "./manifest.ts"
import { cacheReplays, type CheckResult } from "./verdict.ts"

const home = homedir()
const orbstack = `${home}/.orbstack/run/docker.sock`

const allowedNames = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TERM",
  "LANG",
  "TZ",
  "BUN_INSTALL",
  "DOCKER_HOST",
]

/**
 * The environment every host check runs in, built from an allowlist instead of copying the
 * operator's. Provider keys, `GH_TOKEN`, `SSH_AUTH_SOCK`, the variables `~/.config/akter/load`
 * exports and anything else the operator's shell holds never reach a step, so a check cannot
 * print or use them; a check that needs a value gets it from the manifest. Color forcing is absent
 * and NO_COLOR set because the flags suite compares a child process's stdout to a bare number.
 */
export const baseEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env))
    if (allowedNames.includes(name) || name.startsWith("LC_")) env[name] = value
  env.PATH = `${home}/.bun/bin:/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}`
  env.CI = "true"
  env.NO_COLOR = "1"
  if (env.DOCKER_HOST === undefined && existsSync(orbstack)) env.DOCKER_HOST = `unix://${orbstack}`
  return env
}

/**
 * A port the kernel has just handed out, for suites whose default ports other agents' dev servers
 * already hold.
 */
export const freePort = () => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = server.port
  server.stop(true)
  return String(port)
}

const descendants = async (pid: number): Promise<number[]> => {
  const children = (await $`pgrep -P ${pid}`.quiet().nothrow().text())
    .split("\n")
    .filter((line) => line !== "")
    .map(Number)
  const deeper = await Promise.all(children.map(descendants))
  return [...children, ...deeper.flat()]
}

const killTree = async (pid: number) => {
  for (const target of [pid, ...(await descendants(pid))].reverse())
    try {
      process.kill(target, "SIGKILL")
    } catch {
      continue
    }
}

/** How one step is started: the command line, its environment, and how to stop what it started. */
export interface Launch {
  readonly argv: string[]
  readonly env: NodeJS.ProcessEnv
  readonly stop?: () => Promise<void>
}

/**
 * Runs the steps in order, each in its own bash with `-e` and `pipefail` (on the host under `nice`,
 * or wherever `launch` puts it), appending to one log. The first failing step, or the deadline for
 * the whole list, stops the check; a deadline kills the step's whole process tree, because killing
 * only the shell leaves test runners and browsers consuming the shared Mac, and removes a step's
 * container, which outlives the Docker client that started it.
 */
export async function runSteps(
  steps: ReadonlyArray<Step>,
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
    log: string
    logs: string
    launch?: (step: Step, index: number) => Launch
  },
): Promise<Omit<CheckResult, "where">> {
  const fd = openSync(options.log, "a")
  const started = Date.now()
  let failedStep: string | undefined
  for (const [index, step] of steps.entries()) {
    writeSync(fd, `\n::group:: ${step.name}\n$ ${step.run}\n`)
    const remaining = Math.max(options.timeoutMs - (Date.now() - started), 1000)
    const launch = options.launch?.(step, index) ?? {
      argv: [
        "nice",
        "-n",
        "10",
        "bash",
        "--noprofile",
        "--norc",
        "-eo",
        "pipefail",
        "-c",
        step.run,
      ],
      env: { ...options.env, ...step.env },
    }
    const proc = Bun.spawn(launch.argv, {
      cwd: options.cwd,
      env: launch.env,
      stdout: fd,
      stderr: fd,
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void killTree(proc.pid)
      void launch.stop?.()
    }, remaining)
    const code = await proc.exited
    clearTimeout(timer)
    writeSync(
      fd,
      `\n::endgroup:: exit ${code}${timedOut ? ` (timed out after ${Math.round(options.timeoutMs / 60000)}m)` : ""}\n`,
    )
    if (code !== 0) {
      failedStep = timedOut ? `${step.name} (timeout)` : step.name
      break
    }
  }
  closeSync(fd)
  const replays = failedStep === undefined ? cacheReplays(readFileSync(options.log, "utf8")) : []
  if (replays.length > 0) {
    failedStep = `turbo replayed from cache: ${replays[0]?.trim().slice(0, 120)}`
    appendFileSync(options.log, `\n::error:: ${failedStep}\n`)
  }
  return {
    result: failedStep === undefined ? "pass" : "fail",
    seconds: Math.round((Date.now() - started) / 1000),
    failedStep,
    logs: options.logs,
  }
}

/** The Docker objects this run created, removed by exact name and never by pattern. */
export interface Docker {
  readonly env: NodeJS.ProcessEnv
  readonly containers: string[]
  readonly networks: string[]
}

export async function createNetwork(docker: Docker, name: string) {
  docker.networks.push(name)
  await $`docker network create --label akter.local-verify=1 ${name}`.env(docker.env).quiet()
}

export async function removeNetwork(docker: Docker, name: string) {
  await $`docker network rm ${name}`.env(docker.env).quiet().nothrow()
  docker.networks.splice(docker.networks.indexOf(name), 1)
}

export async function removeContainer(docker: Docker, name: string) {
  await $`docker rm -f ${name}`.env(docker.env).quiet().nothrow()
  const at = docker.containers.indexOf(name)
  if (at !== -1) docker.containers.splice(at, 1)
}

export async function removeAll(docker: Docker) {
  for (const name of docker.containers.slice()) await removeContainer(docker, name)
  for (const name of docker.networks.slice()) await removeNetwork(docker, name)
}
