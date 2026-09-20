/** Cluster adapter contracts only. No runner or transport starts here. */
export interface RunnerIdentity {
  readonly runnerId: string
  readonly advertisedAddress: string
  readonly codeVersion: string
}
export interface RelayCheckpoint {
  readonly actorIncarnation: string
  readonly registeredThrough: string
  readonly deliveredThrough: string
}
