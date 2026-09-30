import {
  ActorError,
  type Failure,
  NotCreated,
  type WatchOptions,
} from "@durable-actors/core/client"
import { Effect, Schema } from "effect"
import { useEffect, useRef, useState } from "react"

/** The newest result of a watched query and how the watch stands. */
export interface WatchResult<Output> {
  /** The newest result, or `undefined` until the first one arrives. */
  readonly data: Output | undefined
  /** How the watch ended, if it did. */
  readonly error: Failure | undefined
}

/** How long a watch of an actor no command has created yet waits before asking again. */
const NOT_CREATED_RETRY = "500 millis"

/**
 * Follows a watched query: `data` is the newest result, replaced each time the
 * query's answer changes. The watch reopens when its connection drops and
 * shows the current state first. An actor no command has created yet is asked
 * for again until one does. Nothing runs on the server during rendering, so it
 * is safe under SSR. `watch` is a handle's `Query.watch` bound to its input;
 * `deps` is named by the caller, as for `useEffect`. `error` is the Promise
 * client's: a declared error or an `ActorError`.
 */
export const useWatch = <Output>(
  watch: (options: WatchOptions) => AsyncIterable<Output>,
  deps: ReadonlyArray<unknown>,
): WatchResult<Output> => {
  const [result, setResult] = useState<WatchResult<Output>>({ data: undefined, error: undefined })
  const latest = useRef(watch)
  latest.current = watch

  useEffect(() => {
    const controller = new AbortController()
    setResult({ data: undefined, error: undefined })

    const follow = async (): Promise<void> => {
      try {
        for await (const data of latest.current({ signal: controller.signal }))
          setResult({ data, error: undefined })
      } catch (thrown) {
        const error = thrown as Failure

        if (controller.signal.aborted) return

        if (Schema.is(ActorError)(error) && Schema.is(NotCreated)(error.reason)) {
          await Effect.runPromise(Effect.sleep(NOT_CREATED_RETRY))

          return controller.signal.aborted ? undefined : follow()
        }

        setResult((current) => ({ ...current, error }))
      }
    }

    void follow()

    return () => controller.abort()
  }, deps)

  return result
}
