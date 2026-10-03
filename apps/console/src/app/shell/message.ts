import { Schema as S } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { UrlRequest } from "foldkit/navigation"
import { Url } from "foldkit/url"
import { Dialog } from "./model.ts"
import { PageData } from "./page.ts"
import { Preference } from "./theme.ts"

/** Everything that can happen in the console, named for what happened. */
export const Message = defineMessageUnion({
  ChangedUrl: { url: Url },
  RequestedUrl: { request: UrlRequest },
  RequestedHref: { href: S.String },
  LoadedPage: { page: S.Option(PageData) },
  ToggledDrawer: {},
  ClosedDrawer: {},
  OpenedPalette: {},
  ToggledPalette: {},
  ClosedPalette: {},
  ChangedPaletteQuery: { query: S.String },
  MovedPaletteSelection: { step: S.Literals([1, -1]) },
  HighlightedPaletteItem: { id: S.String },
  ChosePaletteItem: {},
  ChoseTheme: { preference: Preference },
  ChangedField: { name: S.String, value: S.String },
  ToggledSetting: { key: S.String },
  ChoseSetting: { key: S.String, value: S.String },
  ChangedSettingsQuery: { query: S.String },
  SubmittedForm: { form: S.String },
  OpenedDialog: { dialog: Dialog },
  ClosedDialog: {},
  ConfirmedDialog: {},
  CopiedText: { text: S.String, label: S.String },
  DismissedToast: { id: S.String },
  TickedTail: {},
  ToggledTail: {},
  ChangedTailFilter: { filter: S.String },
  RetriedDeadLetter: { id: S.String },
  RetriedAllDeadLetters: {},
  SignedOut: {},
  CompletedEffect: {},
})
export type Message = typeof Message.Type

export const {
  ChangedUrl,
  RequestedUrl,
  RequestedHref,
  LoadedPage,
  ToggledDrawer,
  ClosedDrawer,
  OpenedPalette,
  ToggledPalette,
  ClosedPalette,
  ChangedPaletteQuery,
  MovedPaletteSelection,
  HighlightedPaletteItem,
  ChosePaletteItem,
  ChoseTheme,
  ChangedField,
  ToggledSetting,
  ChoseSetting,
  ChangedSettingsQuery,
  SubmittedForm,
  OpenedDialog,
  ClosedDialog,
  ConfirmedDialog,
  CopiedText,
  DismissedToast,
  TickedTail,
  ToggledTail,
  ChangedTailFilter,
  RetriedDeadLetter,
  RetriedAllDeadLetters,
  SignedOut,
  CompletedEffect,
} = Message
