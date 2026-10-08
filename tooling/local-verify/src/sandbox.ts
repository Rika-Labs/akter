import { $ } from "bun"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

export interface Sandbox {
  readonly env: NodeJS.ProcessEnv
  readonly image: string
  readonly checkout: string
  readonly network: string
  readonly uid: number
  readonly gid: number
}

const dockerfile = `${import.meta.dirname}/../sandbox/Dockerfile`

export const sandboxHome = "/work/.local/sandbox-home"

/**
 * The argv that runs one step inside the sandbox. Every grant is listed here and nowhere else: one
 * bind mount of the checkout, one tmpfs, one network and a fixed environment. Nothing is inherited
 * from the maintainer's process, so no home directory, secret file, SSH agent socket, Docker
 * socket or token can reach the container, and the capability set is empty.
 */
export function sandboxArgv(
  sandbox: Sandbox,
  container: string,
  environment: Readonly<Record<string, string>>,
  command: string,
): string[] {
  const variables = {
    ...environment,
    CI: "true",
    NO_COLOR: "1",
    HOME: sandboxHome,
    TMPDIR: "/tmp",
  }
  return [
    "docker",
    "run",
    "--rm",
    "--init",
    "--name",
    container,
    "--label",
    "akter.local-verify=1",
    "--network",
    sandbox.network,
    "--user",
    `${sandbox.uid}:${sandbox.gid}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "8192",
    "--tmpfs",
    "/tmp:rw,exec,size=4g",
    "--mount",
    `type=bind,source=${sandbox.checkout},target=/work`,
    "--workdir",
    "/work",
    ...Object.entries(variables).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    sandbox.image,
    "bash",
    "--noprofile",
    "--norc",
    "-eo",
    "pipefail",
    "-c",
    command,
  ]
}

/**
 * Builds the sandbox image from the tool checkout's own Dockerfile when this Dockerfile's digest
 * has no image yet. The build context is the Dockerfile's directory alone, never the pull request.
 */
export async function ensureImage(env: NodeJS.ProcessEnv): Promise<string> {
  const digest = createHash("sha256").update(readFileSync(dockerfile)).digest("hex").slice(0, 12)
  const image = `akter-verify-sandbox:${digest}`
  const present = await $`docker image inspect ${image}`.env(env).quiet().nothrow()
  if (present.exitCode === 0) return image
  await $`docker build --label akter.local-verify=1 -t ${image} ${import.meta.dirname}/../sandbox`
    .env(env)
    .quiet()
  return image
}
