export function branchPolicy({
  base,
  branch,
  author,
}: {
  base: string
  branch: string
  author: string
}) {
  if (base !== "main") throw new Error("Only main is a merge target")

  if (author === "dependabot[bot]" && branch.startsWith("dependabot/")) return

  if (!/^(feat|fix|chore|docs|refactor|test|ci)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch))
    throw new Error(
      "Branch must be type/slug, optionally type/issue-slug (e.g. fix/login or fix/42-login)",
    )
}

export interface Evidence {
  currentSha: string
  runSha: string
  conclusion: string
  event: string
  repository: string
  runRepository: string
  artifact: { name: string; expired: boolean; size: number }
}

export function evidencePolicy(e: Evidence) {
  if (
    e.currentSha !== e.runSha ||
    e.conclusion !== "success" ||
    e.repository !== e.runRepository ||
    e.event !== "pull_request"
  )
    throw new Error("Evidence is stale, failed, or from an untrusted run")

  if (e.artifact.expired || e.artifact.size <= 0 || e.artifact.name !== `evidence-${e.currentSha}`)
    throw new Error("Current-SHA evidence artifact required")
}
