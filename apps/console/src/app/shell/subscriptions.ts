import { Duration, Schema as S, Stream } from "effect"
import * as Subscription from "foldkit/subscription"
import { fixturesEnabled } from "../api/client.ts"
import { AppRoute } from "../navigation/routes.ts"
import { type Message, TickedTail, ToggledPalette } from "./message.ts"
import type { Model } from "./model.ts"

/**
 * The console's long-lived inputs: ⌘K or Ctrl+K toggles the palette anywhere, even while typing,
 * on every platform, since browsers report the platform unreliably to pick only one,
 * and the fixture-mode live tail ticks while the commands page is open and not paused.
 */
export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  palette: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Subscription.keyBindings({
          bindings: ["Meta+k", "Control+k"].map((keys) => ({
            keys,
            mapEvent: () => ToggledPalette(),
            whileTyping: "Allow" as const,
            preventDefault: true,
          })),
        }),
    },
  ),
  tail: entry(
    { live: S.Boolean },
    {
      modelToDependencies: (model) => ({
        live:
          AppRoute.isAnyOf(["Commands"])(model.route) && !model.tail.paused && fixturesEnabled(),
      }),
      dependenciesToStream: ({ live }) =>
        live
          ? Stream.tick(Duration.millis(1400)).pipe(Stream.map(() => TickedTail()))
          : Stream.empty,
    },
  ),
}))
