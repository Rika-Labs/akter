import { $ } from "bun"
import { signoffMarker } from "./report.ts"
import type { StatusPlan } from "./verdict.ts"

export interface PullRequest {
  readonly headRefOid: string
  readonly headRefName: string
  readonly baseRefName: string
  readonly author: { readonly login: string }
  readonly isCrossRepository: boolean
  readonly state: string
  readonly body: string
}

export const readPull = async (repository: string, number: number): Promise<PullRequest> =>
  (await $`gh pr view ${number} -R ${repository} --json headRefOid,headRefName,baseRefName,author,isCrossRepository,state,body`.json()) as PullRequest

const sendJson = async (method: string, path: string, payload: string) =>
  $`gh api -X ${method} ${path} --input - < ${new Response(payload)}`.quiet()

export const postStatus = (repository: string, sha: string, status: StatusPlan) =>
  sendJson(
    "POST",
    `repos/${repository}/statuses/${sha}`,
    JSON.stringify({
      state: status.state,
      context: status.context,
      description: status.description,
    }),
  )

export const replaceBody = (repository: string, number: number, body: string) =>
  sendJson("PATCH", `repos/${repository}/pulls/${number}`, JSON.stringify({ body }))

/**
 * One sign-off comment per head SHA: a rerun on the same SHA edits the comment it left before, so a
 * pull request accumulates one comment per verified head and no duplicates. Only a comment written
 * by the account that is posting is ever edited, so a contributor who copies the marker into their
 * own comment cannot make the tool rewrite it.
 */
export async function postSignoff(repository: string, number: number, sha: string, body: string) {
  const me = (await $`gh api user --jq .login`.text()).trim()
  const lines =
    await $`gh api --paginate repos/${repository}/issues/${number}/comments --jq ${".[] | {id, body, author: .user.login}"}`.text()
  const comments = lines
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { id: number; body: string; author: string })
  const existing = comments.find(
    (comment) => comment.author === me && comment.body.startsWith(signoffMarker(sha)),
  )
  if (existing)
    return sendJson(
      "PATCH",
      `repos/${repository}/issues/comments/${existing.id}`,
      JSON.stringify({ body }),
    )
  return sendJson("POST", `repos/${repository}/issues/${number}/comments`, JSON.stringify({ body }))
}
