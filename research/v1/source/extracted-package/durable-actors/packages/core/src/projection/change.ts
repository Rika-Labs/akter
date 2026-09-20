/** Source positions are actor-local, never a global ordering guarantee. */
export interface ChangePosition {
  readonly actorIncarnation: string
  readonly sequence: string
  readonly transactionId: string
  readonly ordinal: number
}
export interface ProjectionSource {
  readonly application: string
  readonly environment: string
  readonly actorType: string
  readonly actorId: string
  readonly tableId: string
  readonly schemaVersion: number
}
