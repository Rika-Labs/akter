import { closeDialog, openDialog } from "@akter/ui"
import { Duration, Effect, Schema as S } from "effect"
import * as Command from "foldkit/command"
import * as Navigation from "foldkit/navigation"
import { AppRoute } from "../navigation/routes.ts"
import { CompletedEffect, DismissedToast, LoadedPage } from "./message.ts"
import { loadPage } from "./page.ts"
import { applyPreference, Preference } from "./theme.ts"

/** Loads the open route's data through its client. */
export const LoadPage = Command.define("LoadPage", {
  args: { route: AppRoute },
  messages: [LoadedPage],
  execute: ({ route }) => loadPage(route).pipe(Effect.map((page) => LoadedPage({ page }))),
})

/** Moves to another console URL without reloading. */
export const PushUrl = Command.define("PushUrl", {
  args: { href: S.String },
  messages: [CompletedEffect],
  execute: ({ href }) => Navigation.pushUrl(href).pipe(Effect.as(CompletedEffect())),
})

/** Leaves the console for an external page. */
export const LoadExternal = Command.define("LoadExternal", {
  args: { href: S.String },
  messages: [CompletedEffect],
  execute: ({ href }) => Navigation.load(href).pipe(Effect.as(CompletedEffect())),
})

/** Applies and stores the Appearance preference. */
export const ApplyTheme = Command.define("ApplyTheme", {
  args: { preference: Preference },
  messages: [CompletedEffect],
  execute: ({ preference }) => applyPreference(preference).pipe(Effect.as(CompletedEffect())),
})

/** Shows a dialog modally once it has rendered, focusing `focus` inside it. */
export const ShowDialog = Command.define("ShowDialog", {
  args: { id: S.String, focus: S.String },
  messages: [CompletedEffect],
  execute: ({ id, focus }) =>
    openDialog({ id, focusSelector: focus }).pipe(Effect.as(CompletedEffect())),
})

/** Closes a dialog and returns focus to whatever opened it. */
export const HideDialog = Command.define("HideDialog", {
  args: { id: S.String },
  messages: [CompletedEffect],
  execute: ({ id }) => closeDialog(id).pipe(Effect.as(CompletedEffect())),
})

/** Copies text to the clipboard; a refused permission is not worth an error state. */
export const WriteClipboard = Command.define("WriteClipboard", {
  args: { text: S.String },
  messages: [CompletedEffect],
  execute: ({ text }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
      Effect.ignore,
      Effect.as(CompletedEffect()),
    ),
})

/** Dismisses a toast after it has been readable for a few seconds. */
export const ExpireToast = Command.define("ExpireToast", {
  args: { id: S.String },
  messages: [DismissedToast],
  execute: ({ id }) => Effect.sleep(Duration.seconds(4.5)).pipe(Effect.as(DismissedToast({ id }))),
})

/**
 * Closes any open dropdown after navigation. Menus use the platform popover, which only light-
 * dismisses on outside clicks, so a link chosen inside one would otherwise leave it open.
 */
export const HidePopovers = Command.define("HidePopovers", {
  messages: [CompletedEffect],
  execute: Effect.sync(() => {
    for (const element of document.querySelectorAll<HTMLElement>(":popover-open"))
      element.hidePopover()
    document.getElementById("main")?.scrollTo({ top: 0 })
  }).pipe(Effect.as(CompletedEffect())),
})
