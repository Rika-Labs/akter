/** Logical identity only. Resolution and authorization are not implemented. */
export interface ActorAddress {
  readonly application: string
  readonly environment: string
  readonly actorType: string
  readonly actorId: string
  readonly incarnation: string
}
