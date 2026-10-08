import type { CheckResult } from "./verdict.ts"

export interface Summary {
  readonly sha: string
  readonly toolDigest?: string
  readonly cached?: boolean
  readonly results: Readonly<Record<string, CheckResult>>
}

/**
 * Merges earlier partial runs into the current one so a `--only` rerun can complete a sign-off.
 * Evidence counts only when it names the same full commit SHA and was produced by the same manifest
 * and trusted tooling; a result from another commit, from a changed manifest or from before the
 * tooling changed is dropped, as is any run that was not recorded as uncached, because a result
 * Turbo replayed from its cache proves nothing about this head. A later run of a check replaces an
 * earlier one.
 */
export function combineEvidence(
  earlier: ReadonlyArray<Summary>,
  sha: string,
  toolDigest: string,
  current: Readonly<Record<string, CheckResult>>,
): Readonly<Record<string, CheckResult>> {
  const usable = earlier.filter(
    (summary) =>
      summary.sha === sha && summary.toolDigest === toolDigest && summary.cached === false,
  )
  return Object.assign({}, ...usable.map((summary) => summary.results), current)
}
