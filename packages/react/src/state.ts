import type { ClientState, Failure, QueryOptions } from "@durable-actors/core/client"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

/** Anything that hands out actor handles: an `X.client(...)`. */
export interface Handles<Id, Handle> {
  readonly get: (id: Id) => Handle
}

/** The handle of one actor, stable while `client` and `id` are. */
export const useActor = <Id, Handle>(client: Handles<Id, Handle>, id: Id): Handle =>
  useMemo(() => client.get(id), [client, id])

/**
 * A handle's committed state with its pending optimistic reducer inputs
 * applied: it changes at once when a reducer is called, and again when its
 * receipt confirms or rolls it back. `undefined` until committed state is
 * known, and during server rendering.
 */
export const useActorState = <State>(handle: { readonly state: ClientState<State> }) =>
  useSyncExternalStore(
    useCallback((listener: () => void) => handle.state.subscribe(listener), [handle]),
    () => handle.state.current,
    () => undefined,
  )

export interface QueryResult<Output> {
  readonly data: Output | undefined
  readonly error: Failure | undefined
  readonly loading: boolean
  /** Reads again. */
  readonly refetch: () => void
}

/**
 * Runs a query when mounted and whenever `deps` change, reading committed
 * rows without waking the actor. Only the latest read updates the result.
 */
export const useQuery = <Output>(
  query: (options: QueryOptions) => Promise<Output>,
  deps: ReadonlyArray<unknown>,
): QueryResult<Output> => {
  const [result, setResult] = useState<Omit<QueryResult<Output>, "refetch">>({
    data: undefined,
    error: undefined,
    loading: true,
  })

  const [generation, setGeneration] = useState(0)
  const latest = useRef(query)
  latest.current = query

  useEffect(() => {
    const controller = new AbortController()
    setResult((current) => ({ ...current, loading: true }))

    latest.current({ signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ data, error: undefined, loading: false })
      },
      (thrown) => {
        // The Promise client rejects only with declared errors and `ActorError`s.
        const error = thrown as Failure

        if (!controller.signal.aborted)
          setResult((current) => ({ ...current, error, loading: false }))
      },
    )

    return () => controller.abort()
    // The caller names what the query depends on, like `useEffect`.
  }, [...deps, generation])

  const refetch = useCallback(() => setGeneration((value) => value + 1), [])

  return { ...result, refetch }
}
