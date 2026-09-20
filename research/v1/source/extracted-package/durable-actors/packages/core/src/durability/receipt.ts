/** Contract-only wire metadata; no receipt persistence is implemented. */
export interface CommandIdentity {
  readonly commandId: string
  readonly payloadDigest: string
  readonly protocolVersion: number
}
export interface CommitReceipt {
  readonly commandId: string
  readonly actorRevision: string
  readonly outcome: "succeeded" | "rejected"
}
export interface AcceptanceReceipt {
  readonly submissionId: string
  readonly acceptedAt: string
}
