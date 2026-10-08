import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { afterAll, beforeAll, expect, it } from "vitest"
import { baseEnv, runSteps } from "./runner.ts"

const secrets = {
  GH_TOKEN: "canary-gh-token",
  GITHUB_TOKEN: "canary-github-token",
  SSH_AUTH_SOCK: "/tmp/canary-agent.sock",
  STRIPE_API_KEY: "canary-stripe",
  FLY_API_TOKEN: "canary-fly",
  AKTER_SECRET: "canary-akter",
  AWS_SECRET_ACCESS_KEY: "canary-aws",
  NPM_TOKEN: "canary-npm",
}
const original = { ...process.env }
const directory = mkdtempSync(`${tmpdir()}/akter-verify-env-test-`)

beforeAll(() => {
  Object.assign(process.env, secrets)
})

afterAll(() => {
  for (const name of Object.keys(secrets)) delete process.env[name]
  Object.assign(process.env, original)
  rmSync(directory, { recursive: true, force: true })
})

it("builds the check environment without any operator secret, whatever the operator's shell exported", () => {
  const env = baseEnv()
  for (const name of Object.keys(secrets)) expect(env).not.toHaveProperty(name)
  expect(Object.values(env)).not.toContain("canary-gh-token")
  expect(env["CI"]).toBe("true")
  expect(env["PATH"]).toContain("/.bun/bin")
})

it("runs a real step whose own environment holds no canary, and still gives it the tools it needs", async () => {
  const log = `${directory}/step.log`
  const result = await runSteps([{ name: "env", run: "env; command -v bun" }], {
    cwd: directory,
    env: baseEnv(),
    timeoutMs: 60_000,
    log,
    logs: directory,
  })
  const output = readFileSync(log, "utf8")
  expect(result.result).toBe("pass")
  for (const [name, value] of Object.entries(secrets)) {
    expect(output).not.toContain(`${name}=`)
    expect(output).not.toContain(value)
  }
  expect(output).toMatch(/bun$/m)
})
