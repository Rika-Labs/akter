import { Effect, Schema } from "effect"

/**
 * What wrote a segment. Replay of a tail runs only on a matching build, since
 * a changed handler, schema, engine or locale database can change an action's
 * outcome. A field the runtime does not report is empty: Bun reports no
 * time-zone database version, and `process.versions.v8` under Bun names the
 * Node version it emulates, not its engine.
 */
export const Build = Schema.Struct({
  /** Digest of the application bundle, from the server. */
  bundle: Schema.String,
  /** Framework version, from the server. */
  framework: Schema.String,
  runtime: Schema.String,
  runtimeVersion: Schema.String,
  engine: Schema.String,
  engineVersion: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  icu: Schema.String,
  unicode: Schema.String,
  tz: Schema.String,
})

/** A segment's build. */
export type Build = typeof Build.Type

/** The parts of a build only the server knows. */
export interface Application {
  readonly bundle: string
  readonly framework: string
}

/** The running process's build, completed with the server's application identity. */
export const runtimeBuild = (application: Application) =>
  Effect.sync((): Build => {
    const versions = process.versions
    const bun = globalThis.Bun !== undefined
    return {
      bundle: application.bundle,
      framework: application.framework,
      runtime: bun ? "bun" : "node",
      runtimeVersion: (bun ? versions["bun"] : versions.node) ?? "",
      engine: bun ? "JavaScriptCore" : "V8",
      engineVersion: (bun ? versions["webkit"] : versions.v8) ?? "",
      platform: process.platform,
      arch: process.arch,
      icu: versions["icu"] ?? "",
      unicode: versions["unicode"] ?? "",
      tz: versions["tz"] ?? "",
    }
  })
