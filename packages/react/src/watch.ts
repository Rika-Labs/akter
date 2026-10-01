import type { Failure, WatchOptions } from "@rikalabs/akter/client"
import { useEffect, useRef, useState } from "react"
import { followCreated } from "./created.ts"

/** The newest result of a watched query and how the watch stands. */
export interface WatchResult<Output> {
  /** The newest result, or `undefined` until the first one arrives. */
  readonly data: Output | undefined
  /** How the watch ended, if it did. */
  readonly error: Failure | undefined
}

/**
 * Follows a watched query: `data` is the newest result, replaced each time the
 * query's answer changes. The watch reopens when its connection drops and
 * shows the current state first. An actor no command has created yet is asked
 * for again until one does. Nothing runs on the server during rendering, so it
 * is safe under SSR. `watch` is a handle's `Query.watch` bound to its input,
 * or a fleet client's `View.subscribe` bound to its filter;
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

    void followCreated(controller.signal, async () => {
      for await (const data of latest.current({ signal: controller.signal }))
        setResult({ data, error: undefined })
    }).then((error) => {
      if (error !== undefined) setResult((current) => ({ ...current, error }))
    })

    return () => controller.abort()
  }, deps)

  return result
}
