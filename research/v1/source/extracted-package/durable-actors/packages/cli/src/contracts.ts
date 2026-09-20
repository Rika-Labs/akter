/** CLI output options only; command execution is not implemented. */
export interface CliOutputOptions {
  readonly format: "human" | "json" | "ndjson"
  readonly environment: string
}
