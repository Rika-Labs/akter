/** Explicit Node platform marker; no process is started by this package. */
export interface NodePlatformConfiguration {
  readonly runtime: "node"
  readonly bindHost: string
  readonly port: number
}
