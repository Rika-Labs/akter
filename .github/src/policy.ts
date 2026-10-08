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
