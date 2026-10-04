import { CredentialsFromEnv } from "@distilled.cloud/github/Credentials"
import * as Actions from "@distilled.cloud/github/actions"
import * as Checks from "@distilled.cloud/github/checks"
import * as Pulls from "@distilled.cloud/github/pulls"
import * as Repos from "@distilled.cloud/github/repos"
import { Effect, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"

/**
 * The GitHub calls the evidence gate makes, as promises for its imperative
 * workflow script. One runtime owns the credentials, read from `GITHUB_TOKEN`,
 * and the HTTP client until `dispose`.
 */
const runtime = ManagedRuntime.make(Layer.mergeAll(CredentialsFromEnv, FetchHttpClient.layer))

export const github = {
  dispose: () => runtime.dispose(),
  getPull: (owner: string, repo: string, number: number) =>
    runtime.runPromise(
      Pulls.get({ owner, repo, pull_number: number }).pipe(
        Effect.map((pr) => ({
          head: { sha: pr.head.sha, ref: pr.head.ref, repository: pr.head.repo?.full_name ?? null },
          baseSha: pr.base.sha,
          state: pr.state,
          body: pr.body ?? "",
        })),
      ),
    ),
  artifacts: (owner: string, repo: string, run_id: number) =>
    runtime.runPromise(Actions.listWorkflowRunArtifacts({ owner, repo, run_id, per_page: 100 })),
  check: (
    owner: string,
    repo: string,
    sha: string,
    conclusion: "success" | "failure",
    summary: string,
  ) =>
    runtime.runPromise(
      Checks.create({
        owner,
        repo,
        head_sha: sha,
        name: "Current SHA evidence",
        conclusion,
        output: { title: "Current SHA evidence", summary },
      }).pipe(Effect.asVoid),
    ),
  contentSha: (owner: string, repo: string, ref: string, path: string) =>
    runtime.runPromise(
      Repos.getContent({ owner, repo, ref, path }).pipe(
        Effect.map((content) =>
          !Array.isArray(content) && "sha" in content ? content.sha : undefined,
        ),
      ),
    ),
}
