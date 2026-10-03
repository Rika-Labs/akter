import { Function, Match, Option, Predicate } from "effect"
import * as Navigation from "foldkit/navigation"
import type { Return } from "foldkit/update"
import { type Url, toString } from "foldkit/url"
import { openingTail } from "../commands/fixtures.ts"
import { nextTurn } from "../commands/client.ts"
import { AppRoute } from "../navigation/routes.ts"
import * as Routes from "../navigation/routes.ts"
import {
  ApplyTheme,
  ExpireToast,
  HideDialog,
  HidePopovers,
  LoadExternal,
  LoadPage,
  PushUrl,
  ShowDialog,
  WriteClipboard,
} from "./command.ts"
import { Message } from "./message.ts"
import type { Dialog, Flags, Model, Toast } from "./model.ts"
import { paletteResults } from "./palette.ts"

type Result = Return<Model, Message>

/** The dialog element every modal renders into, and the palette's own. */
export const dialogId = "console-dialog"
export const paletteId = "command-palette"

const defaultToggles = {
  openInNewTab: false,
  pauseOnScroll: true,
  showReplayed: true,
  compactTables: false,
  reduceMotion: false,
  "notify.deployFinished": true,
  "notify.deployFailed": true,
  "notify.deadLetters": true,
  "notify.weeklyUsage": false,
  "notify.slackDeploys": false,
  "notify.slackDeadLetters": true,
  twoFactor: false,
} satisfies Readonly<Record<string, boolean>>

const defaultChoices = {
  defaultEnvironment: "production",
  timeZone: "local",
  spendLimit: "500",
  environment: "production",
  inviteRole: "Member",
  homeRegion: "us-east-1",
  auditFilter: "all",
  receiptRetention: "30",
  keyScope: "deploy",
  variableEnvironment: "production",
} satisfies Readonly<Record<string, string>>

const initial = (flags: Flags, url: Url): Result => {
  const route = Routes.parseUrl(url)
  return {
    model: {
      route,
      workspace: flags.workspace,
      page: Option.none(),
      loading: true,
      theme: flags.theme,
      drawer: false,
      palette: { open: false, query: "" },
      dialog: Option.none(),
      toasts: [],
      toastCount: 0,
      fields: {},
      toggles: defaultToggles,
      choices: defaultChoices,
      settingsQuery: "",
      tail: { entries: openingTail, paused: false, filter: "all", next: openingTail.length },
      resolved: [],
      revoked: [],
    },
    commands: [LoadPage({ route }), ApplyTheme({ preference: flags.theme })],
  }
}

const toast = (model: Model, entry: Omit<Toast, "id">): Result => {
  const id = `toast-${String(model.toastCount)}`
  return {
    model: {
      ...model,
      toasts: [...model.toasts.slice(-2), { ...entry, id }],
      toastCount: model.toastCount + 1,
    },
    commands: [ExpireToast({ id })],
  }
}

const go = (model: Model, href: string): Result => ({
  model: { ...model, drawer: false },
  commands: [PushUrl({ href })],
})

const then = (first: Result, next: (model: Model) => Result): Result => {
  const second = next(first.model)
  return { model: second.model, commands: [...(first.commands ?? []), ...(second.commands ?? [])] }
}

const closePalette = (model: Model): Result => ({
  model: { ...model, palette: { open: false, query: "" } },
  commands: model.palette.open ? [HideDialog({ id: paletteId })] : [],
})

const openPalette = (model: Model): Result => ({
  model: { ...model, drawer: false, palette: { open: true, query: "" } },
  commands: [ShowDialog({ id: paletteId, focus: `#${paletteId}-input` })],
})

const dialogFocus = (dialog: Dialog): string =>
  Match.value(dialog).pipe(
    Match.tags({
      CreateKey: () => "#key-name",
      AddVariable: () => "#variable-name",
      SendCommand: () => "#command-name",
      DeleteProject: () => "#delete-confirm",
    }),
    Match.orElse(() => "[data-dialog-confirm]"),
  )

const deadLetterIds = (model: Model): ReadonlyArray<string> =>
  Option.match(model.page, {
    onNone: () => [],
    onSome: (page) =>
      Predicate.isTagged(page, "JobsPage") ? page.deadLetters.map((letter) => letter.id) : [],
  })

const confirm = (model: Model, dialog: Dialog): Result =>
  Match.value(dialog).pipe(
    Match.tagsExhaustive({
      DiscardDeadLetter: ({ id }) =>
        toast(
          { ...model, resolved: [...model.resolved, id] },
          { title: `Discarded ${id}`, description: "The job will not run again.", tone: "idle" },
        ),
      RevokeKey: ({ name }) =>
        toast(
          { ...model, revoked: [...model.revoked, name] },
          { title: `Revoked ${name}`, description: "Requests using it now fail.", tone: "idle" },
        ),
      CreateKey: () =>
        toast(model, {
          title: `Created ${model.fields["key-name"] ?? "key"}`,
          description: "Copy it now; it is shown once.",
          tone: "live",
        }),
      AddVariable: () =>
        toast(model, {
          title: `Saved ${model.fields["variable-name"] ?? "variable"}`,
          description: "It takes effect on the next deploy.",
          tone: "live",
        }),
      SendCommand: ({ address }) =>
        toast(model, {
          title: `${model.fields["command-name"] ?? "Command"} committed`,
          description: `${address} · 3.2 ms`,
          tone: "live",
        }),
      RollBack: ({ commit }) =>
        toast(model, {
          title: `Rolling back to ${commit}`,
          description: "Actors move to the previous runners as they drain.",
          tone: "live",
        }),
      DeleteProject: ({ project }) =>
        toast(model, {
          title: `${project} scheduled for deletion`,
          description: "Runners stop now; the database is kept for 7 days.",
          tone: "danger",
        }),
    }),
  )

const submit = (model: Model, form: string): Result =>
  Match.value(form).pipe(
    Match.when("sign-in", () => go(model, Routes.overview())),
    Match.when("sign-up", () => go(model, Routes.verifyEmail())),
    Match.when("verify-resend", () =>
      toast(model, {
        title: "Verification email sent",
        description: model.fields["email"] ?? "",
        tone: "live",
      }),
    ),
    Match.when("forgot", () => ({
      model: { ...model, fields: { ...model.fields, recoverySent: "yes" } },
    })),
    Match.when("reset", () =>
      then(go(model, Routes.signIn()), (next) =>
        toast(next, {
          title: "Password updated",
          description: "Sign in with your new password.",
          tone: "live",
        }),
      ),
    ),
    Match.when("accept-invitation", () =>
      then(go(model, Routes.overview()), (next) =>
        toast(next, {
          title: "Welcome to Acme",
          description: "You joined as a Member.",
          tone: "live",
        }),
      ),
    ),
    Match.when("decline-invitation", () => go(model, Routes.signIn())),
    Match.when("onboarding-organization", () => go(model, Routes.onboarding({ step: "project" }))),
    Match.when("onboarding-project", () => go(model, Routes.onboarding({ step: "deploy" }))),
    Match.when("onboarding-deploy", () =>
      go(model, Routes.project({ project: model.fields["project-name"] ?? "support-bot" })),
    ),
    Match.when("invite-member", () =>
      toast(
        { ...model, fields: { ...model.fields, "invite-email": "" } },
        { title: `Invitation sent to ${model.fields["invite-email"] ?? "them"}`, tone: "live" },
      ),
    ),
    Match.when("add-domain", () =>
      toast(
        { ...model, fields: { ...model.fields, domain: "" } },
        {
          title: `Added ${model.fields["domain"] ?? "domain"}`,
          description: "Waiting for its CNAME record.",
          tone: "idle",
        },
      ),
    ),
    Match.orElse(() => toast(model, { title: "Saved", tone: "live" })),
  )

const step = (model: Model, message: Message): Result =>
  Message.match(message, {
    ChangedUrl: ({ url }) => {
      const route = Routes.parseUrl(url)
      return {
        model: { ...model, route, drawer: false, loading: true },
        commands: [LoadPage({ route }), HidePopovers()],
      }
    },
    RequestedUrl: ({ request }) =>
      Navigation.UrlRequest.match(request, {
        Internal: ({ url }): Result => go(model, toString(url)),
        External: ({ href }): Result => ({ model, commands: [LoadExternal({ href })] }),
      }),
    RequestedHref: ({ href }) => then(closePalette(model), (next) => go(next, href)),
    LoadedPage: ({ page }) => ({ model: { ...model, page, loading: false } }),
    ToggledDrawer: () => ({ model: { ...model, drawer: !model.drawer } }),
    ClosedDrawer: () => ({ model: { ...model, drawer: false } }),
    OpenedPalette: () => (model.palette.open ? { model } : openPalette(model)),
    ToggledPalette: () => (model.palette.open ? closePalette(model) : openPalette(model)),
    ClosedPalette: () => closePalette(model),
    ChangedPaletteQuery: ({ query }) => {
      const next = { ...model, palette: { ...model.palette, query } }
      const first = paletteResults(next)[0]
      return {
        model: {
          ...next,
          palette:
            first === undefined ? { open: true, query } : { open: true, query, active: first.id },
        },
      }
    },
    MovedPaletteSelection: ({ step }) => {
      const results = paletteResults(model)
      if (results.length === 0) return { model }
      const current = results.findIndex((item) => item.id === model.palette.active)
      const index = current === -1 ? 0 : (current + step + results.length) % results.length
      const active = results[index]?.id
      return {
        model: {
          ...model,
          palette: active === undefined ? model.palette : { ...model.palette, active },
        },
      }
    },
    HighlightedPaletteItem: ({ id }) => ({
      model: { ...model, palette: { ...model.palette, active: id } },
    }),
    ChosePaletteItem: () => {
      const results = paletteResults(model)
      const chosen = results.find((item) => item.id === model.palette.active) ?? results[0]
      if (chosen === undefined) return { model }
      return then(closePalette(model), (next) => step(next, chosen.onSelect))
    },
    ChoseTheme: ({ preference }) =>
      then(closePalette(model), (next) => ({
        model: { ...next, theme: preference },
        commands: [ApplyTheme({ preference })],
      })),
    ChangedField: ({ name, value }) => ({
      model: { ...model, fields: { ...model.fields, [name]: value } },
    }),
    ToggledSetting: ({ key }) => ({
      model: { ...model, toggles: { ...model.toggles, [key]: model.toggles[key] !== true } },
    }),
    ChoseSetting: ({ key, value }) => ({
      model: { ...model, choices: { ...model.choices, [key]: value } },
    }),
    ChangedSettingsQuery: ({ query }) => ({ model: { ...model, settingsQuery: query } }),
    SubmittedForm: ({ form }) => submit(model, form),
    OpenedDialog: ({ dialog }) =>
      then(closePalette(model), (next) => ({
        model: { ...next, dialog: Option.some(dialog) },
        commands: [ShowDialog({ id: dialogId, focus: dialogFocus(dialog) })],
      })),
    ClosedDialog: () => ({
      model: { ...model, dialog: Option.none() },
      commands: [HideDialog({ id: dialogId })],
    }),
    ConfirmedDialog: () =>
      Option.match(model.dialog, {
        onNone: () => ({ model }),
        onSome: (dialog) =>
          then(
            {
              model: { ...model, dialog: Option.none() },
              commands: [HideDialog({ id: dialogId })],
            },
            (next) => confirm(next, dialog),
          ),
      }),
    CopiedText: ({ text, label }) =>
      then({ model, commands: [WriteClipboard({ text })] }, (next) =>
        toast(next, { title: `Copied ${label}`, tone: "live" }),
      ),
    DismissedToast: ({ id }) => ({
      model: { ...model, toasts: model.toasts.filter((entry) => entry.id !== id) },
    }),
    TickedTail: () =>
      model.tail.paused || !AppRoute.isAnyOf(["Commands"])(model.route)
        ? { model }
        : {
            model: {
              ...model,
              tail: {
                ...model.tail,
                entries: [nextTurn(model.tail.next), ...model.tail.entries].slice(0, 60),
                next: model.tail.next + 1,
              },
            },
          },
    ToggledTail: () => ({
      model: { ...model, tail: { ...model.tail, paused: !model.tail.paused } },
    }),
    ChangedTailFilter: ({ filter }) => ({ model: { ...model, tail: { ...model.tail, filter } } }),
    RetriedDeadLetter: ({ id }) =>
      toast(
        { ...model, resolved: [...model.resolved, id] },
        { title: `Retrying ${id}`, description: "Its attempt count starts again.", tone: "live" },
      ),
    RetriedAllDeadLetters: () => {
      const open = deadLetterIds(model).filter((id) => !model.resolved.includes(id))
      return toast(
        { ...model, resolved: [...model.resolved, ...open] },
        { title: `Retrying ${String(open.length)} jobs`, tone: "live" },
      )
    },
    SignedOut: () => then(closePalette(model), (next) => go(next, Routes.signIn())),
    CompletedEffect: () => ({ model }),
  })

/** The first Model for a URL, and the Commands that load its page and apply the stored theme. */
export const init: {
  (flags: Flags, url: Url): Result
  (url: Url): (flags: Flags) => Result
} = Function.dual(2, initial)

/** Applies one Message to the Model and returns the Commands it causes. */
export const update: {
  (model: Model, message: Message): Result
  (message: Message): (model: Model) => Result
} = Function.dual(2, step)
