import { Schema as S } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import { Tail } from "../commands/model.ts"
import { AppRoute } from "../navigation/routes.ts"
import { Workspace } from "../workspace/model.ts"
import { PageData } from "./page.ts"
import { Preference } from "./theme.ts"

/** The modal dialog that is open, and what it acts on. */
export const Dialog = defineTaggedUnion({
  DiscardDeadLetter: { id: S.String },
  RevokeKey: { name: S.String },
  CreateKey: {},
  AddVariable: {},
  SendCommand: { address: S.String },
  RollBack: { commit: S.String },
  DeleteProject: { project: S.String },
})
export type Dialog = typeof Dialog.Type

/** A transient notification. */
export const Toast = S.Struct({
  id: S.String,
  title: S.String,
  description: S.optional(S.String),
  tone: S.Literals(["live", "success", "warning", "danger", "idle"]),
})
export type Toast = typeof Toast.Type

/** The ⌘K palette: whether it is open, what is typed, and which result is highlighted. */
export const Palette = S.Struct({
  open: S.Boolean,
  query: S.String,
  active: S.optional(S.String),
})
export type Palette = typeof Palette.Type

/**
 * The console's whole state. Page data is whatever the current route's client returned; `fields`,
 * `toggles` and `choices` hold form inputs, switches and selects by name so every settings row and
 * form shares one update path.
 */
export const Model = S.Struct({
  route: AppRoute,
  workspace: Workspace,
  page: S.Option(PageData),
  loading: S.Boolean,
  theme: Preference,
  drawer: S.Boolean,
  palette: Palette,
  dialog: S.Option(Dialog),
  toasts: S.Array(Toast),
  toastCount: S.Finite,
  fields: S.Record(S.String, S.String),
  toggles: S.Record(S.String, S.Boolean),
  choices: S.Record(S.String, S.String),
  settingsQuery: S.String,
  tail: Tail,
  resolved: S.Array(S.String),
  revoked: S.Array(S.String),
})
export type Model = typeof Model.Type

/** What the console needs before its first render: the workspace and the stored theme. */
export const Flags = S.Struct({ workspace: Workspace, theme: Preference })
export type Flags = typeof Flags.Type
