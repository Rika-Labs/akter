import { cpus, hostname, release, totalmem, type as osType } from "node:os"
import { Effect } from "effect"

const git = (args: ReadonlyArray<string>) =>
  Effect.sync(() => {
    const result = Bun.spawnSync(["git", ...args])

    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
  })

const packageVersion = (name: string) =>
  Effect.promise(() =>
    import(`${name}/package.json`, { with: { type: "json" } }).then(
      (module: { default: { version: string } }) => module.default.version,
      () => "unknown",
    ),
  )

/**
 * The code under test. On a local merge of unmerged pull requests, `merges`
 * lists each merge commit's parents, so a result names every head it combined.
 */
export const source = Effect.gen(function* () {
  const sha = (yield* git(["rev-parse", "HEAD"])) ?? "unknown"
  const base = yield* git(["merge-base", "HEAD", "origin/main"])

  const merges =
    base === undefined
      ? []
      : ((yield* git(["rev-list", "--merges", "--parents", `${base}..HEAD`])) ?? "")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => {
            const [commit, ...parents] = line.split(" ")

            return { commit: commit!, parents }
          })

  return {
    sha,
    shortSha: sha.slice(0, 7),
    branch: (yield* git(["rev-parse", "--abbrev-ref", "HEAD"])) ?? "unknown",
    mainBase: base ?? "unknown",
    dirty: ((yield* git(["status", "--porcelain", "--untracked-files=no"])) ?? "") !== "",
    merges,
  }
})

export const machine = (external: boolean) =>
  Effect.sync(() => {
    const processors = cpus()

    return {
      cpuModel: processors[0]?.model ?? "unknown",
      logicalCpus: processors.length,
      memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      os: `${osType()} ${release()}`,
      hostname: hostname(),
      topology: external
        ? "benchmark client and actor runtime on this machine; Postgres at BENCH_DATABASE_URL"
        : "one machine; the benchmark client, actor runtime, and Postgres container share its CPUs; database over loopback TCP",
    }
  })

export const runtimeVersions = Effect.gen(function* () {
  return {
    bun: Bun.version,
    effect: yield* packageVersion("effect"),
    pglite: yield* packageVersion("@electric-sql/pglite"),
  }
})
