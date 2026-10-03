import { Effect, Schema as S, Stream } from "effect"
import * as Subscription from "foldkit/subscription"
import { openTurns } from "../commands/client.ts"
import { AppRoute } from "../navigation/routes.ts"
import {
  ConnectedTail,
  type Message,
  StoppedTail,
  StreamedTurn,
  ToggledPalette,
} from "./message.ts"
import type { Model } from "./model.ts"

/**
 * The console's long-lived inputs: ⌘K or Ctrl+K toggles the palette anywhere, even while typing,
 * on every platform, since browsers report the platform unreliably to pick only one,
 * and the hosted command stream runs only while live data is open and not paused.
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
    { live: S.Boolean, session: S.Finite },
    {
      modelToDependencies: (model) => ({
        live:
          AppRoute.isAnyOf(["Commands"])(model.route) &&
          !model.loading &&
          !model.pageSample &&
          !model.tail.paused &&
          ["connecting", "live"].includes(model.tailStatus),
        session: model.tailSession,
      }),
      dependenciesToStream: ({ live, session }) =>
        live
          ? Stream.unwrap(
              openTurns.pipe(
                Effect.map((turns) =>
                  Stream.concat(
                    Stream.succeed(ConnectedTail({ session })),
                    turns.pipe(
                      Stream.map((entry) => StreamedTurn({ session, entry })),
                      Stream.concat(
                        Stream.succeed(
                          StoppedTail({
                            session,
                            kind: "Disconnected",
                            message: "The live connection ended. Reconnect to refresh commands.",
                          }),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ).pipe(
              Stream.catch((error) =>
                Stream.succeed(StoppedTail({ session, kind: error.kind, message: error.message })),
              ),
            )
          : Stream.empty,
    },
  ),
}))
