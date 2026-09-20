/** Explicit Bun platform marker; no native API is used in portable core. */
export interface BunPlatformConfiguration {
  readonly runtime: "bun"
  readonly bindHost: string
  readonly port: number
}
