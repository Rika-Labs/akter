import { $ } from "bun"
import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir, userInfo } from "node:os"
import { afterAll, beforeAll, expect, it } from "vitest"
import { baseEnv, createNetwork, removeAll, type Docker } from "./runner.ts"
import { ensureImage, sandboxArgv, type Sandbox } from "./sandbox.ts"

const marker = "AKTER-VERIFY-CANARY"
const secretsDirectory = `${homedir()}/.config/akter`
const canaryPath = `${secretsDirectory}/verify-canary-${randomUUID()}.env`
const canarySecret = `${marker}-${randomUUID()}`
const checkoutSecret = `${marker}-CHECKOUT-${randomUUID()}`
const hostEnv = baseEnv()
const docker: Docker = { env: hostEnv, containers: [], networks: [] }
const checkout = mkdtempSync(`${tmpdir()}/akter-verify-sandbox-test-`)
const hostSecrets = {
  SSH_AUTH_SOCK: "/tmp/host-ssh-agent.sock",
  GH_TOKEN: `${marker}-GH-${randomUUID()}`,
  GITHUB_TOKEN: `${marker}-GITHUB-${randomUUID()}`,
  AKTER_SECRET: `${marker}-ENV-${randomUUID()}`,
}
const originalEnv = { ...process.env }
let box: Sandbox
let createdDirectory = false

beforeAll(async () => {
  createdDirectory = !(await Bun.file(secretsDirectory).exists()) && true
  mkdirSync(secretsDirectory, { recursive: true })
  writeFileSync(canaryPath, `API_KEY=${canarySecret}\n`)
  chmodSync(canaryPath, 0o600)
  writeFileSync(`${checkout}/marker.txt`, checkoutSecret)
  Object.assign(process.env, hostSecrets)
  const network = `akter-verify-sandbox-test-${process.pid}-net`
  await createNetwork(docker, network)
  box = {
    env: { PATH: hostEnv.PATH, HOME: hostEnv.HOME, DOCKER_HOST: hostEnv.DOCKER_HOST },
    image: await ensureImage(hostEnv),
    checkout,
    network,
    uid: userInfo().uid,
    gid: userInfo().gid,
  }
}, 1_200_000)

afterAll(async () => {
  rmSync(canaryPath, { force: true })
  if (createdDirectory) rmSync(secretsDirectory, { recursive: true, force: true })
  rmSync(checkout, { recursive: true, force: true })
  for (const name of Object.keys(hostSecrets)) delete process.env[name]
  Object.assign(process.env, originalEnv)
  await removeAll(docker)
})

const inside = async (name: string, script: string) => {
  const container = `akter-verify-sandbox-test-${process.pid}-${name}`
  docker.containers.push(container)
  const result = await $`${sandboxArgv(box, container, { PROBE_CANARY_PATH: canaryPath }, script)}`
    .env(box.env)
    .quiet()
    .nothrow()
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

it("the host canary exists beside the secrets and is readable by the same user on the host", () => {
  expect(readFileSync(canaryPath, "utf8")).toContain(canarySecret)
})

it("cannot find or read the canary, its directory or its contents anywhere in the container", async () => {
  const probe = [
    'echo "direct:$(test -e "$PROBE_CANARY_PATH" && echo present || echo absent)"',
    'for prefix in /mnt/mac /host_mnt /host /mnt/host /mnt/host_home; do test -e "$prefix$PROBE_CANARY_PATH" && echo "prefixed:$prefix"; done',
    'test -d "$(dirname "$PROBE_CANARY_PATH")" && echo "directory:present" || echo "directory:absent"',
    'echo "byname:$(find / -xdev -name "verify-canary-*" 2>/dev/null | wc -l | tr -d " ")"',
    `echo "bycontent:$(grep -rIl --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev '${marker}-' / 2>/dev/null | sort | tr '\\n' ' ')"`,
    'echo "users:$(ls /Users 2>/dev/null | wc -l | tr -d " ")"',
  ].join("\n")
  const { code, out } = await inside("canary", probe)
  expect(code).toBe(0)
  expect(out).toContain("direct:absent")
  expect(out).toContain("directory:absent")
  expect(out).toContain("byname:0")
  expect(out).toContain("users:0")
  expect(out).not.toContain("prefixed:")
  expect(out).not.toContain(canarySecret)
  expect(out).toContain("bycontent:/work/marker.txt ")
})

it("sees the checkout it was given, so the probes above can find a secret that is there", async () => {
  const { code, out } = await inside("checkout", "cat /work/marker.txt")
  expect(code).toBe(0)
  expect(out).toBe(checkoutSecret)
})

it("inherits no host variable: no SSH agent, gh or other token, and no value from the host process", async () => {
  const { code, out } = await inside(
    "env",
    "env; echo ---; command -v gh ssh ssh-add docker || true",
  )
  expect(code).toBe(0)
  const [variables = "", tools = ""] = out.split("---\n")
  const names = variables
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => line.slice(0, line.indexOf("=")))
  for (const name of Object.keys(hostSecrets)) expect(names).not.toContain(name)
  for (const value of Object.values(hostSecrets)) expect(out).not.toContain(value)
  expect(names.filter((name) => /TOKEN|SSH|SECRET|KEY|DOCKER|^GH_|^AKTER/.test(name))).toEqual([])
  expect(tools.trim()).toBe("")
})

it("has no Docker socket or any other socket, and the Docker daemon is unreachable", async () => {
  const { code, out } = await inside(
    "sockets",
    'echo "sockets:$(find / -xdev -type s 2>/dev/null | wc -l | tr -d " ")"; ls /var/run/docker.sock /run/docker.sock 2>&1 | head -2 || true; echo "ssh:$(ls -d "$HOME/.ssh" /root/.ssh 2>/dev/null | wc -l | tr -d " ")"',
  )
  expect(code).toBe(0)
  expect(out).toContain("sockets:0")
  expect(out).toContain("No such file or directory")
  expect(out).toContain("ssh:0")
})

it("mounts only the checkout, runs unprivileged as the host user and writes only there", async () => {
  const { code, out } = await inside(
    "mounts",
    [
      'echo "uid:$(id -u)"',
      'echo "caps:$(grep CapEff /proc/self/status | tr -d "\\t")"',
      "awk '{print $5}' /proc/self/mountinfo | sort -u | grep -E '^/(work|Users|home|root|mnt|host|run/host)' || true",
      'touch /work/written.txt && echo "work:writable"',
      'touch /usr/denied 2>/dev/null && echo "usr:writable" || echo "usr:denied"',
    ].join("\n"),
  )
  expect(code).toBe(0)
  expect(out).toContain(`uid:${userInfo().uid}`)
  expect(out).toContain("CapEff:0000000000000000")
  const mounts = out.split("\n").filter((line) => line.startsWith("/"))
  expect(mounts).toEqual(["/work"])
  expect(out).toContain("work:writable")
  expect(out).toContain("usr:denied")
})

it("is started with a fixed argument list that names one mount and no privilege, socket or host namespace", () => {
  const argv = sandboxArgv(box, "name", { A: "1" }, "true")
  const joined = argv.join(" ")
  expect(argv.filter((argument) => argument === "--mount")).toHaveLength(1)
  expect(argv).toContain("--cap-drop")
  expect(argv[argv.indexOf("--cap-drop") + 1]).toBe("ALL")
  for (const forbidden of ["--privileged", "--volume", "-v", "--pid", "--ipc", "--device"])
    expect(argv).not.toContain(forbidden)
  expect(joined).not.toContain("docker.sock")
  expect(joined).not.toContain("network host")
  expect(joined).not.toContain(homedir())
})
