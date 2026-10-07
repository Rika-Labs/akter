import { Schema } from "effect"

import { DeploymentId, Timestamp } from "./primitives.ts"

/** Limits apply to both recent reads and each resumed long poll. */
export const MAX_LOG_LINES = 200
export const MAX_LOG_TEXT_BYTES = 4096
export const MAX_LOG_WINDOW_SECONDS = 3600
export const MAX_LOG_WAIT_SECONDS = 20

/** An opaque position, bound to the authorized resource, never a provider app selector. */
export const LogCursor = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384))

export const LogLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LOG_LINES }))

export const LogWait = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: MAX_LOG_WAIT_SECONDS }),
)

export const logQuery = {
  since: Schema.optional(Timestamp),
  limit: Schema.optional(LogLimit),
  cursor: Schema.optional(LogCursor),
  wait: Schema.optional(LogWait),
}

/** Customer runner output only; build output and control-plane logs use different surfaces. */
export const RunnerLogLine = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  deploymentId: DeploymentId,
  runnerId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  at: Timestamp,
  /** Fly merges output streams; unknown preserves that limitation instead of inventing a stream. */
  stream: Schema.Literals(["stdout", "stderr", "unknown"]),
  text: Schema.String.check(
    Schema.makeFilter(
      (text) =>
        new TextEncoder().encode(text).byteLength <= MAX_LOG_TEXT_BYTES ||
        "Log text exceeds the byte limit",
    ),
  ),
})
export type RunnerLogLine = typeof RunnerLogLine.Type

/** The cursor advances even on an empty poll; truncated also covers clipped line text. */
export const RunnerLogPage = Schema.Struct({
  lines: Schema.Array(RunnerLogLine).check(Schema.isMaxLength(MAX_LOG_LINES)),
  cursor: LogCursor,
  truncated: Schema.Boolean,
})
export type RunnerLogPage = typeof RunnerLogPage.Type
