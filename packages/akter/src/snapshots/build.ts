import type { Build } from "../execution/entries.ts"

/** The framework version recorded in every build id. */
export const frameworkVersion = "0.2.0-dev"

interface Versions {
  readonly [name: string]: string | undefined
}

const runtimeVersions = (): Versions => globalThis.process?.versions ?? {}

/**
 * The build id of this process: the application digest the host supplies, the framework version,
 * and the runtime, JavaScript engine, platform, architecture and ICU, Unicode and time-zone database
 * versions, any of which can change what an action computes.
 */
const current = (application: string): Build => {
  const versions = runtimeVersions()
  const bun = versions["bun"]
  return {
    application,
    framework: frameworkVersion,
    runtime: bun === undefined ? `node ${versions["node"] ?? "unknown"}` : `bun ${bun}`,
    engine: bun === undefined ? `v8 ${versions["v8"] ?? "unknown"}` : `jsc ${versions["webkit"] ?? "unknown"}`,
    platform: globalThis.process?.platform ?? "unknown",
    arch: globalThis.process?.arch ?? "unknown",
    icu: versions["icu"] ?? "none",
    unicode: versions["unicode"] ?? "unknown",
    tz: versions["tz"] ?? "unknown",
  }
}

const same = (left: Build, right: Build): boolean =>
  left.application === right.application &&
  left.framework === right.framework &&
  left.runtime === right.runtime &&
  left.engine === right.engine &&
  left.platform === right.platform &&
  left.arch === right.arch &&
  left.icu === right.icu &&
  left.unicode === right.unicode &&
  left.tz === right.tz

/** Build identity: which code wrote a segment, and whether this process may replay it. */
export const Builds = { current, same }
