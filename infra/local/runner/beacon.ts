import { Actor, Anonymous } from "@rikalabs/akter"
import { Effect, Schema } from "effect"

const Signaled = Actor.event("Signaled", { label: Schema.String })

export const Configure = Actor.command("Configure", {
  payload: {
    label: Schema.String,
    password: Schema.String,
    apiToken: Schema.String,
    notes: Schema.String,
  },
  success: Schema.String,
})

export const Start = Actor.command("Start")

const Pulse = Actor.command("Pulse")

/**
 * The actors a locally built example runner serves so a test can read live
 * telemetry back: a `Beacon` takes a payload with credentials in it through
 * `Configure` and emits an event its feed carries, and a `Ticker`, once
 * `Start` creates it, is ticked by a schedule every five seconds.
 */
export const Beacon = Actor.make("Beacon", {
  key: Schema.NonEmptyString,
  events: [Signaled],
  feeds: [Signaled],
  api: { Configure },
  access: ({ caller }) => !Schema.is(Anonymous)(caller),
})

export const Ticker = Actor.make("Ticker", {
  key: Schema.NonEmptyString,
  api: { Start },
  internal: { Pulse },
  schedules: { "@every 5 seconds": Pulse },
  access: ({ caller }) => !Schema.is(Anonymous)(caller),
})

/** Handlers for `Beacon` and `Ticker`. */
export const beaconLayers = [
  Beacon.toLayer({
    Configure: Effect.fnUntraced(function* ({ label }) {
      const turn = yield* Beacon.Turn
      yield* turn.emit(Signaled.make({ label }))

      return label
    }),
  }),
  Ticker.toLayer({ Start: () => Effect.void, Pulse: () => Effect.void }),
] as const
