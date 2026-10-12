import { expect, it } from "vitest"
import { canaryChannel, canaryVersion, releaseTags, releaseVersion } from "./version.ts"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

it("accepts a matching release unit and rejects a different CLI alpha before publication", () => {
  expect(releaseVersion({ framework: "0.1.0-alpha.7", cli: "0.1.0-alpha.7" })).toBe("0.1.0-alpha.7")
  expect(() => releaseVersion({ framework: "0.1.0-alpha.7", cli: "0.1.0-alpha.8" })).toThrow(
    "CLI version 0.1.0-alpha.8 does not match framework version 0.1.0-alpha.7",
  )
  expect(() => releaseVersion({ framework: "1.0.0", cli: "1.0.0+different-build" })).toThrow(
    "does not match",
  )
})

it("promotes pre-1.0 channels but never next canaries or post-1.0 prereleases", () => {
  expect(releaseTags("0.1.0-alpha.2+build.7")).toEqual({ tag: "alpha", latest: true })
  expect(releaseTags("0.9.7-rc.12")).toEqual({ tag: "rc", latest: true })
  expect(releaseTags("0.9.7")).toEqual({ tag: "latest", latest: false })
  expect(releaseTags("1.0.0-alpha.1")).toEqual({ tag: "alpha", latest: false })
  expect(releaseTags("1.0.0")).toEqual({ tag: "latest", latest: false })
  expect(releaseTags("0.1.0-next.321.1.g123456abcdef")).toEqual({ tag: "next", latest: false })
  expect(() => releaseTags("0.1.0-123.1")).toThrow("dist-tag name")
})

it("gives canary runs and reruns distinct npm versions without retaining alpha or build metadata", () => {
  expect(canaryVersion({ version: "0.1.0-alpha.2+build.7", build: "321.1.g123456abcdef" })).toBe(
    "0.1.0-next.321.1.g123456abcdef",
  )
  expect(canaryVersion({ version: "0.1.0-alpha.2", build: "321.2.g123456abcdef" })).toBe(
    "0.1.0-next.321.2.g123456abcdef",
  )
  expect(canaryVersion({ version: "1.2.3", build: "654.1.gfedcba654321" })).toBe(
    "1.2.3-next.654.1.gfedcba654321",
  )
  for (const build of ["", "321.0.g123456abcdef", "321.1.g123456", "321.1.g123456ABCDEF"])
    expect(() => canaryVersion({ version: "0.1.0-alpha.2", build })).toThrow("Canary build")
})

it("runs the manifest gate before publishing and refuses a mismatched package on disk", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  return runtime
    .runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "akter-release-version-" })
        yield* fs.makeDirectory(`${directory}/packages/akter`, { recursive: true })
        yield* fs.makeDirectory(`${directory}/apps/cli`, { recursive: true })
        yield* fs.writeFileString(
          `${directory}/packages/akter/package.json`,
          '{"version":"0.1.0-alpha.7"}',
        )
        yield* fs.writeFileString(
          `${directory}/apps/cli/package.json`,
          '{"version":"0.1.0-alpha.8"}',
        )
        const child = Bun.spawn(["bun", new URL("./version.ts", import.meta.url).pathname], {
          cwd: directory,
          stdout: "pipe",
          stderr: "pipe",
        })
        const stderr = yield* Effect.promise(() => new Response(child.stderr).text())
        expect(yield* Effect.promise(() => child.exited)).not.toBe(0)
        expect(stderr).toContain(
          "CLI version 0.1.0-alpha.8 does not match framework version 0.1.0-alpha.7",
        )
        yield* fs.writeFileString(
          `${directory}/apps/cli/package.json`,
          '{"version":"0.1.0-alpha.7"}',
        )
        const matching = Bun.spawn(["bun", new URL("./version.ts", import.meta.url).pathname], {
          cwd: directory,
          stdout: "pipe",
          stderr: "pipe",
        })
        const output = yield* Effect.promise(() => new Response(matching.stdout).text())
        expect(yield* Effect.promise(() => matching.exited)).toBe(0)
        expect(output).toBe("tag=alpha\npromote_latest=true\n")
        const workflow = yield* fs.readFileString(
          new URL("../../workflows/release.yml", import.meta.url).pathname,
        )
        const gate = workflow.indexOf("bun .github/src/release/version.ts")
        expect(gate).toBeGreaterThan(-1)
        expect(gate).toBeLessThan(workflow.indexOf("npm publish"))
        expect(workflow).toContain("github.event.workflow_run.head_sha == github.sha")
        const identity = /test "\$commit" = "\$GITHUB_SHA" \|\| \{[^\n]+\}/.exec(workflow)?.[0]
        expect(identity).toBeDefined()
        if (identity === undefined) throw new Error("Provenance SHA gate is missing")
        for (const [sha, status] of [
          ["verified", 0],
          ["unverified", 1],
        ] as const)
          expect(
            Bun.spawnSync(["env", "commit=verified", `GITHUB_SHA=${sha}`, "bash", "-c", identity])
              .exitCode,
          ).toBe(status)
        const promotion = /bun -e '([^']+)' "\$version" "\$current"/.exec(workflow)?.[1]
        expect(promotion).toBeDefined()
        if (promotion === undefined) throw new Error("Latest promotion predicate is missing")
        for (const [candidate, current, status] of [
          ["0.1.0-alpha.2", "0.1.0-alpha.1", 0],
          ["0.1.0-alpha.2", "0.1.0-alpha.2", 0],
          ["0.1.0-alpha.2", "0.1.0-alpha.10", 1],
          ["0.1.0-alpha.2", "0.1.0", 1],
        ] as const)
          expect(Bun.spawnSync(["bun", "-e", promotion, candidate, current]).exitCode).toBe(status)
      }).pipe(Effect.scoped),
    )
    .finally(() => runtime.dispose())
})

it("names rewrite canaries with their own channel and never selects latest or next for them", () => {
  const build = "321.1.g123456abcdef"
  const rewrite = canaryVersion({ version: "0.2.0", build, channel: "rewrite" })
  expect(rewrite).toBe("0.2.0-rewrite.321.1.g123456abcdef")
  expect(canaryVersion({ version: "0.2.0", build })).toBe("0.2.0-next.321.1.g123456abcdef")
  expect(releaseTags(rewrite)).toEqual({ tag: "rewrite", latest: false })
  expect(releaseTags(canaryVersion({ version: "0.2.0", build }))).toEqual({
    tag: "next",
    latest: false,
  })
  expect(() => canaryVersion({ version: "0.2.0", build, channel: "latest" })).toThrow(
    "Canary channel",
  )
  expect(() => canaryVersion({ version: "0.2.0", build, channel: "alpha" })).toThrow(
    "Canary channel",
  )
  expect(() =>
    canaryVersion({ version: "0.2.0", build: "321.1.g123456", channel: "rewrite" }),
  ).toThrow("Canary build")
  expect(canaryChannel("main")).toBe("next")
  expect(canaryChannel("rewrite/0.2")).toBe("rewrite")
  for (const branch of ["", "master", "rewrite/0.2.1", "refs/heads/main", "feature/rewrite/0.2"])
    expect(() => canaryChannel(branch)).toThrow("does not publish canaries")
})

const releaseWorkflow = () => {
  const text = readFileSync(new URL("../../workflows/release.yml", import.meta.url), "utf8")
  const steps = (
    Bun.YAML.parse(text) as {
      readonly jobs: {
        readonly publish: {
          readonly steps: ReadonlyArray<{ readonly name?: string; readonly run?: string }>
        }
      }
    }
  ).jobs.publish.steps
  return {
    text,
    script: (name: string) => {
      const run = steps.find((step) => step.name === name)?.run
      if (run === undefined) throw new Error(`Release step ${name} is missing`)
      return run
    },
  }
}

const git = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

it("publishes a rewrite canary only from a commit on origin/rewrite/0.2 and a next canary only from origin/main", () => {
  const workflow = releaseWorkflow()
  const select = workflow
    .script("Select a verified canary or tagged release")
    .replace(".github/src/release/version.ts", new URL("./version.ts", import.meta.url).pathname)
  const directory = mkdtempSync(join(tmpdir(), "akter-release-channel-"))
  try {
    mkdirSync(join(directory, "packages/akter"), { recursive: true })
    mkdirSync(join(directory, "apps/cli"), { recursive: true })
    for (const manifest of ["packages/akter", "apps/cli"])
      writeFileSync(join(directory, manifest, "package.json"), '{"version":"0.2.0"}')
    git(directory, "init", "--quiet", "--initial-branch=base")
    git(directory, "add", ".")
    git(directory, "commit", "--quiet", "-m", "base")
    git(directory, "checkout", "--quiet", "-b", "rewrite")
    git(directory, "commit", "--quiet", "--allow-empty", "-m", "rewrite")
    const rewrite = git(directory, "rev-parse", "HEAD")
    git(directory, "checkout", "--quiet", "base")
    git(directory, "checkout", "--quiet", "-b", "trunk")
    git(directory, "commit", "--quiet", "--allow-empty", "-m", "main")
    const main = git(directory, "rev-parse", "HEAD")
    git(directory, "update-ref", "refs/remotes/origin/rewrite/0.2", rewrite)
    git(directory, "update-ref", "refs/remotes/origin/main", main)

    const select_ = (commit: string, branch: string) => {
      git(directory, "checkout", "--quiet", "--detach", commit)
      const output = join(directory, "github-output")
      writeFileSync(output, "")
      const result = Bun.spawnSync(["bash", "-c", select], {
        cwd: directory,
        env: {
          ...process.env,
          CANARY: "true",
          CANARY_BRANCH: branch,
          GITHUB_SHA: commit,
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: directory,
          RELEASE_TAG: "",
        },
      })
      return {
        status: result.exitCode,
        stdout: result.stdout.toString(),
        output: readFileSync(output, "utf8"),
      }
    }

    const published = select_(rewrite, "rewrite/0.2")
    expect(published.status).toBe(0)
    expect(published.output).toBe("tag=rewrite\npromote_latest=false\n")
    expect(published.stdout).toContain("Publishing a rewrite canary")

    const next = select_(main, "main")
    expect(next.status).toBe(0)
    expect(next.output).toBe("tag=next\npromote_latest=false\n")

    for (const [commit, branch] of [
      [main, "rewrite/0.2"],
      [rewrite, "main"],
      [rewrite, "feature/rewrite"],
      [rewrite, ""],
    ] as const) {
      const refused = select_(commit, branch)
      expect(refused.status).not.toBe(0)
      expect(refused.output).toBe("")
    }
    expect(select_(main, "rewrite/0.2").stdout).toContain(`${main} is not on rewrite/0.2`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it("waits for the Verify run of the pushed commit and refuses a failed one", () => {
  const wait = releaseWorkflow().script("Wait for a successful Verify run on the pushed commit")
  const directory = mkdtempSync(join(tmpdir(), "akter-release-wait-"))
  try {
    git(directory, "init", "--quiet")
    git(directory, "commit", "--quiet", "--allow-empty", "-m", "pushed")
    writeFileSync(join(directory, "gh"), '#!/bin/sh\nprintf "%s" "$STUB_STATES"\n', { mode: 0o755 })
    const run = (states: string) =>
      Bun.spawnSync(["bash", "-c", wait], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          STUB_STATES: states,
          GITHUB_REPOSITORY: "Rika-Labs/akter",
          CANARY_BRANCH: "rewrite/0.2",
        },
      })
    expect(run("success\n").exitCode).toBe(0)
    expect(run("failed\nsuccess\n").exitCode).toBe(0)
    const failed = run("failed\n")
    expect(failed.exitCode).toBe(1)
    expect(failed.stderr.toString()).toContain("Verify did not succeed")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it("triggers a rewrite canary from pushes to rewrite/0.2 and keeps main and tags as they were", () => {
  const { text } = releaseWorkflow()
  const workflow = Bun.YAML.parse(text) as {
    readonly on: {
      readonly push: {
        readonly tags: ReadonlyArray<string>
        readonly branches: ReadonlyArray<string>
      }
      readonly workflow_run: { readonly branches: ReadonlyArray<string> }
    }
  }
  expect(workflow.on.push.branches).toEqual(["rewrite/0.2"])
  expect(workflow.on.push.tags).toEqual(["v*"])
  expect(workflow.on.workflow_run.branches).toEqual(["main"])
  expect(text).toContain('--canary-channel "$DIST_TAG"')
  expect(text).toContain("if: steps.release.outputs.promote_latest == 'true'")
  expect(text).toContain('npm publish "$package" --provenance --access public --tag "$DIST_TAG"')
  expect(text).not.toContain("tag=next")
})
