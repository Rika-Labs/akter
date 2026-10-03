import { Effect } from "effect"

/** Reports listener failures without interrupting notification; Node lacks the browser's global reporter. */
export const reportError: typeof globalThis.reportError = (error) => {
  if (globalThis.reportError !== undefined) globalThis.reportError(error)
  else Effect.runSync(Effect.logError(error))
}
