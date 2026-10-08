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

  if (!/^(feat|fix|chore|docs|refactor|test|ci)\/[1-9]\d*-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch))
    throw new Error("Branch must be type/issue-slug (e.g. fix/42-login)")
}
