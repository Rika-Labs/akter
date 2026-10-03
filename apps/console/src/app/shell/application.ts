import { Effect } from "effect"
import type { UrlRequest } from "foldkit/navigation"
import type { HtmlBuilder } from "foldkit/html"
import type { Url } from "foldkit/url"
import { loadWorkspace } from "../workspace/client.ts"
import { ChangedUrl, Message, RequestedUrl } from "./message.ts"
import { Flags, Model } from "./model.ts"
import { subscriptions } from "./subscriptions.ts"
import { readPreference } from "./theme.ts"
import { init, update } from "./update.ts"
import { view } from "./view.ts"

/** The workspace and stored theme, resolved before the first render so nothing flashes. */
export const flags = Effect.all({ workspace: loadWorkspace, theme: readPreference })

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
  devTools: {
    Message,
    show: "Development" as const,
    position: "BottomRight" as const,
  },
}
