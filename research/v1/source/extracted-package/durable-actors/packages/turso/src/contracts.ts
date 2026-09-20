import type * as Redacted from "effect/Redacted"

/** Provisioning result shape, not a provisioning implementation. */
export interface DatabaseBinding {
  readonly providerDatabaseId: string
  readonly url: string
  readonly authToken: Redacted.Redacted<string>
  readonly actorIncarnation: string
}
export interface DatabaseCapabilityEvidence {
  readonly engine: string
  readonly testedAt: string
  readonly transactionGate: "unverified" | "passed" | "failed"
  readonly triggerGate: "unverified" | "passed" | "failed"
  readonly fenceGate: "unverified" | "passed" | "failed"
}
