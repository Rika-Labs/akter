/** A conformance scenario declaration, not a passing fake test. */
export interface ConformanceScenario {
  readonly id: string
  readonly gate: string
  readonly failurePoint: string
  readonly invariant: string
  readonly status: "not-implemented" | "implemented"
}
