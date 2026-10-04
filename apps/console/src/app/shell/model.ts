import { Schema as S } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import { Tail } from "../commands/model.ts"
import { CommandAnswer, CommandScope, CommandSubmission } from "../commands/model.ts"
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
  SendCommand: { scope: CommandScope, address: S.String },
  RollBack: { id: S.String, commit: S.String },
  Redeploy: { id: S.String, commit: S.String },
  DeleteProject: { project: S.String },
  KeyCreated: { name: S.String, secret: S.String },
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

/** Why the open route's page could not load, in words the person can act on. */
export const PageError = S.Struct({ kind: S.String, message: S.String })
export type PageError = typeof PageError.Type

/**
 * The ⌘K palette: whether it is open, what is typed, which result is highlighted, and the actor
 * types and addresses the runtime found for the query typed when it was searched.
 */
export const Palette = S.Struct({
  open: S.Boolean,
  query: S.String,
  active: S.optional(S.String),
  found: S.optional(
    S.Struct({ query: S.String, actorTypes: S.Array(S.String), actors: S.Array(S.String) }),
  ),
})
export type Palette = typeof Palette.Type

/**
 * The console's whole state. Page data is whatever the current route's client returned, or `pageError` when it failed;
 * `pageSample` marks page data that came from fixtures and must stay read-only; `allowSignIn` is set when the API refused the session, so the sign-in screen opens even while
 * Better Auth still holds one; `fields`,
 * `toggles` and `choices` hold form inputs, switches and selects by name so every settings row and
 * form shares one update path. `changingDeployment` holds the deployment page a rollback or redeploy
 * started from while it is in flight; it outlives navigation within the project so a second one
 * cannot start, the console opens the new deployment only if that page is still open when the
 * change lands, and signing out or switching project releases it.
 */
export const Model = S.Struct({
  route: AppRoute,
  workspace: Workspace,
  page: S.Option(PageData),
  pageError: S.Option(PageError),
  pageSample: S.Boolean,
  allowSignIn: S.Boolean,
  submitting: S.Boolean,
  formError: S.Option(S.String),
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
  tailStatus: S.Literals(["idle", "connecting", "live", "paused", "unavailable", "error"]),
  tailSession: S.Finite,
  tailError: S.Option(S.String),
  commandAnswer: S.Option(CommandAnswer),
  commandError: S.Option(S.Struct({ kind: S.String, message: S.String })),
  commandSubmission: S.Option(CommandSubmission),
  sendingCommand: S.Boolean,
  commandSession: S.Finite,
  changingDeployment: S.Option(S.String),
  resolved: S.Array(S.String),
  revoked: S.Array(S.String),
})
export type Model = typeof Model.Type

/** What the console needs before its first render: the workspace and the stored theme. */
export const Flags = S.Struct({ workspace: Workspace, theme: Preference })
export type Flags = typeof Flags.Type

const passwordFields = ["password", "new-password", "confirm-password"]

/** The form fields without any typed password, so a secret never outlives the screen that took it. */
export const withoutPasswords = (fields: Model["fields"]): Model["fields"] =>
  Object.fromEntries(Object.entries(fields).filter(([name]) => !passwordFields.includes(name)))
