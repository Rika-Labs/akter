import { Effect, Option, Predicate, Schema, Stream } from "effect"
import type { AnyFleetView, FleetFilter, FleetPage, FleetRow } from "../tables/fleet.ts"
import { FLEET_PAGE_DEFAULT, FleetPageJson, fleetFilterText } from "./fleet-page.ts"
import type { ClientOptions } from "./make.ts"
import { joinUrl } from "./calls.ts"
import { networkFailure, undecodableFailure } from "./transport.ts"
import { type WatchOptions, watchStream } from "./sessions/watch.ts"

/** Options of one served fleet subscription. */
export interface FleetSubscribeOptions extends WatchOptions {
  /** The most groups a page holds: default 100, at most 1,000. */
  readonly limit?: number
}

/** One served fleet view: `subscribe` follows its pages for the caller's tenant. */
export interface FleetViewClient<V extends AnyFleetView> {
  readonly subscribe: (
    filter?: FleetFilter<V>,
    options?: FleetSubscribeOptions,
  ) => AsyncIterable<FleetPage<FleetRow<V>>>
}

/** The client of served fleet views, by view name. */
export type FleetClient<Views extends ReadonlyArray<AnyFleetView>> = {
  readonly [V in Views[number] as V["name"]]: FleetViewClient<V>
}

const decodePage = Schema.decodeUnknownEffect(FleetPageJson)

/**
 * The Promise client of `options.views`, served by `Actor.serve({ fleet })`. Each
 * `subscribe` is an `AsyncIterable` of pages for the tenant the server
 * authenticates, over `GET /fleet/{View}`: the current page first, then a page
 * whenever the view changed. A dropped connection reopens after a growing,
 * jittered delay, and its first page is the current state. It fails with the
 * `ActorError` that ended it when a retry cannot help, and retries an expired
 * credential once. `options.headers` is read for every attempt.
 */
export const fleetClient = <const Views extends ReadonlyArray<AnyFleetView>>(
  options: Pick<ClientOptions, "baseUrl" | "headers" | "fetch"> & {
    /** The views the server lists in `Actor.serve({ fleet })`. */
    readonly views: Views
  },
): FleetClient<Views> => {
  const views = options.views
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis)

  const provided = Effect.suspend(() => {
    const headers = options.headers

    return Predicate.isFunction(headers)
      ? Effect.promise(() => Promise.resolve(headers()))
      : Effect.succeed(headers)
  })

  const view = (declared: AnyFleetView) => ({
    subscribe: (
      filter: Readonly<Record<string, string | number | boolean>> = {},
      subscribe: FleetSubscribeOptions = {},
    ) => {
      const query = new URLSearchParams(fleetFilterText(filter))
      query.set("limit", String(subscribe.limit ?? FLEET_PAGE_DEFAULT))

      const url = joinUrl({
        baseUrl: options.baseUrl,
        path: `/fleet/${declared.name}?${query.toString()}`,
      })

      return Stream.toAsyncIterable(
        watchStream({
          decode: (json) => decodePage(json).pipe(Effect.mapError(undecodableFailure)),
          declared: () => Option.none(),
          token: () => undefined,
          options: subscribe,
          open: (_version, signal) =>
            Effect.gen(function* () {
              const headers = new Headers(yield* provided)
              headers.set("accept", "text/event-stream")
              headers.set("durable-protocol", "1")

              return yield* Effect.tryPromise({
                try: () => fetch(url, { method: "GET", headers, signal }),
                catch: networkFailure,
              })
            }),
        }),
      )
    },
  })

  return Object.fromEntries(
    views.map((declared) => [declared.name, view(declared)]),
  ) as FleetClient<Views>
}
