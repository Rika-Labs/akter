import type { Manifest } from "./manifest.ts"

export interface CheckResult {
  readonly result: "pass" | "fail"
  readonly seconds: number
  readonly failedStep?: string
  readonly logs: string
  readonly where: "host" | "sandbox" | "tool"
}

export interface CheckReport {
  readonly id: string
  readonly description: string
  readonly outcome: "pass" | "fail" | "missing"
  readonly seconds?: number
  readonly failedStep?: string
  readonly logs?: string
  readonly where?: CheckResult["where"]
}

export interface StatusPlan {
  readonly context: string
  readonly state: "success" | "failure"
  readonly description: string
}

export interface Verdict {
  readonly signedOff: boolean
  readonly checks: ReadonlyArray<CheckReport>
  readonly statuses: ReadonlyArray<StatusPlan>
}

/**
 * Lines in which Turborepo replayed a task from its cache. A replayed task did not run on this
 * head, so a check whose log contains one cannot count toward a sign-off.
 */
export function cacheReplays(log: string): ReadonlyArray<string> {
  return log.split("\n").filter((line) => /cache hit, (replaying|suppressing) logs/.test(line))
}

/**
 * A check with no recorded result is missing, never a pass, and a status is a success only when
 * every check it requires passed, so a partial run can fail a status but can never sign one off.
 */
export function decide(
  manifest: Manifest,
  results: Readonly<Record<string, CheckResult | undefined>>,
): Verdict {
  const checks = manifest.checks.map((check): CheckReport => {
    const found = results[check.id]
    if (found === undefined)
      return { id: check.id, description: check.description, outcome: "missing" }
    return {
      id: check.id,
      description: check.description,
      outcome: found.result,
      seconds: found.seconds,
      failedStep: found.failedStep,
      logs: found.logs,
      where: found.where,
    }
  })
  const statuses = manifest.statuses.map((status): StatusPlan => {
    const bad = checks.filter(
      (check) => status.checks.includes(check.id) && check.outcome !== "pass",
    )
    if (bad.length === 0)
      return {
        context: status.context,
        state: "success",
        description: `Local verification passed: ${status.checks.join(", ")}`.slice(0, 140),
      }
    return {
      context: status.context,
      state: "failure",
      description:
        `Local verification failed or missing: ${bad.map((check) => `${check.id} ${check.outcome}`).join(", ")}`.slice(
          0,
          140,
        ),
    }
  })
  return { signedOff: statuses.every((status) => status.state === "success"), checks, statuses }
}
