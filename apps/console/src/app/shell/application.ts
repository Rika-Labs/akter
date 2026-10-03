import { Effect, Option } from "effect"
import type { UrlRequest } from "foldkit/navigation"
import type { HtmlBuilder } from "foldkit/html"
import type { Url } from "foldkit/url"
import { fixturesEnabled } from "../api/client.ts"
import { auth } from "../auth/session.ts"
import { emptyWorkspace, loadWorkspace } from "../workspace/client.ts"
import { ChangedUrl, Message, RequestedUrl } from "./message.ts"
import { Flags, Model } from "./model.ts"
import { subscriptions } from "./subscriptions.ts"
import { readPreference } from "./theme.ts"
import { init, update } from "./update.ts"
import { view } from "./view.ts"

/**
 * The workspace and stored theme, resolved before the first render so nothing flashes. A visitor
 * with no session, or one whose session cannot be read, starts with the empty workspace and never
 * calls the API; the route's guard then sends them to sign in.
 */
export const flags = Effect.gen(function* () {
  const theme = yield* readPreference
  const signedIn =
    fixturesEnabled() ||
    (yield* auth.session.pipe(
      Effect.map(Option.isSome),
      Effect.orElseSucceed(() => false),
    ))
  const workspace = signedIn ? yield* loadWorkspace : emptyWorkspace
  return { workspace, theme }
})

/** The console's FoldKit program: Model, update, view, routing and subscriptions. */
export const applicationConfig = {
  Model,
  Flags,
  init: (flags: Flags, url: Url) => init(flags, url),
  update: (model: Model, message: Message) => update(model, message),
  view: (model: Model, h: HtmlBuilder<Message>) => view(model, h),
  subscriptions,
  routing: {
    onUrlRequest: (request: UrlRequest) => RequestedUrl({ request }),
    onUrlChange: (url: Url) => ChangedUrl({ url }),
  },
  devTools: false as const,
}
