import { Function, Match, Option, Predicate, Schema as S } from "effect"
import * as Navigation from "foldkit/navigation"
import type { Return } from "foldkit/update"
import { type Url, toString } from "foldkit/url"
import { selectedWindow } from "../api/client.ts"
import { retryable } from "../commands/errors.ts"
import type { CommandScope, CommandSubmission } from "../commands/model.ts"
import { canonicalPayload, toOpeningTail, toTailEntry } from "../commands/mapping.ts"
import { settingsSeed } from "../settings/keys.ts"
import {
  choiceFields,
  hasPaidPlan,
  parseMemberRoleKey,
  parseNotificationKey,
  parseSpendLimit,
  planChoiceKey,
  planChoices,
  spendLimitKey,
  toggleFields,
} from "../settings/keys.ts"
import { slugify } from "../auth/model.ts"
import {
  DeviceEntry,
  DevicePage,
  DeviceRefused,
  DeviceReview,
  normalizeUserCode,
} from "../device/model.ts"
import { billedPlan } from "../settings/model.ts"
import { spendLimitReached } from "../quota/model.ts"
import { AppRoute, isAuthRoute } from "../navigation/routes.ts"
import * as Routes from "../navigation/routes.ts"
import {
  AcceptInvitation,
  ApplyTheme,
  ContinueVerified,
  CreateOrganization,
  CreateProject,
  DecideDevice,
  DeclineInvitation,
  ExpireToast,
  HideDialog,
  HidePopovers,
  LoadExternal,
  LookUpDevice,
  LoadPage,
  LoadWorkspace,
  Mutate,
  PushUrl,
  ReplaceUrl,
  RequestReset,
  ResendVerification,
  SearchActors,
  SettlePaletteQuery,
  ResetPassword,
  SelectEnvironment,
  SelectSeriesWindow,
  SendActorCommand,
  NewCommandId,
  ShowDialog,
  SignIn,
  SignInWithProvider,
  SignOut,
  SignUp,
  WriteClipboard,
} from "./command.ts"
import { Action, canMutate, canSendCommand } from "./action.ts"
import { Message } from "./message.ts"
import { Dialog, type Flags, type Model, type Toast, withoutPasswords } from "./model.ts"
import { paletteResults } from "./palette.ts"
import { currentProject } from "./sidebar.ts"

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

const environments = ["production", "staging", "dev"] as const

const environmentKeys = ["defaultEnvironment", "environment", "variableEnvironment"]

const storedEnvironment = (): string => {
  try {
    const stored = window.sessionStorage.getItem("console-environment")
    return environments.find((name) => name === stored) ?? "production"
  } catch {
    return "production"
  }
}

const defaultChoices = {
  defaultEnvironment: "production",
  timeZone: "local",
  spendLimit: "500",
  environment: "production",
  inviteRole: "member",
  homeRegion: "us-east-1",
  auditFilter: "all",
  receiptRetention: "30",
  keyScope: "write",
  keyProject: "project",
  variableEnvironment: "production",
} satisfies Readonly<Record<string, string>>

const initial = (flags: Flags, url: Url): Result => {
  const route = Routes.parseUrl(url)
  const environment = storedEnvironment()
  const failure = flags.workspace.error
  return {
    model: {
      route,
      workspace: flags.workspace,
      page: Option.none(),
      pageError: Option.none(),
      pageSample: false,
      allowSignIn: false,
      submitting: false,
      formError: Option.none(),
      loading: true,
      theme: flags.theme,
      drawer: false,
      palette: { open: false, query: "" },
      dialog: Option.none(),
      toasts:
        failure === undefined
          ? []
          : [
              {
                id: "toast-0",
                title: "Workspace unavailable",
                description: failure,
                tone: "danger",
              },
            ],
      toastCount: failure === undefined ? 0 : 1,
      fields: {},
      toggles: defaultToggles,
      choices: {
        ...defaultChoices,
        defaultEnvironment: environment,
        environment,
        variableEnvironment: environment,
        seriesWindow: selectedWindow(),
      },
      settingsQuery: "",
      tail: { entries: [], paused: false, filter: "all", next: 0 },
      tailStatus: "idle",
      tailSession: 0,
      tailError: Option.none(),
      commandAnswer: Option.none(),
      commandError: Option.none(),
      commandSubmission: Option.none(),
      sendingCommand: false,
      commandSession: 0,
      changingDeployment: Option.none(),
      resolved: [],
      revoked: [],
    },
    commands: [
      LoadPage({ route }),
      ApplyTheme({ preference: flags.theme }),
      ...(failure === undefined ? [] : [ExpireToast({ id: "toast-0" })]),
    ],
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

const settingsPage = (model: Model) =>
  Option.flatMap(model.page, (page) =>
    Predicate.isTagged(page, "SettingsPage") ? Option.some(page) : Option.none(),
  )

/**
 * Whether a spend limit the views chose would refuse new commands as soon as it is saved, because
 * the month's estimate has already reached it. Such a limit waits for an explicit save.
 */
const refusesRightAway = (model: Model, value: string): boolean => {
  const limitCents = parseSpendLimit(value)
  return Option.exists(
    Option.flatMap(settingsPage(model), (page) => Option.fromNullishOr(page.billing)),
    (billing) =>
      limitCents !== null &&
      limitCents !== undefined &&
      limitCents !== billing.spendLimit.limitCents &&
      spendLimitReached({ limitCents, billing }),
  )
}

const mutate = (model: Model, action: Action): Result =>
  canMutate({ page: model.page, sample: model.pageSample, loading: model.loading, action })
    ? { model, commands: [Mutate({ action })] }
    : toast(model, { title: "Sample data is read-only.", tone: "warning" })

/**
 * Retries or discards dead letters, unless the jobs page's source cannot: then nothing is sent and
 * the person is told why, even when the message bypassed the disabled control.
 */
const resolveDeadLetters = (model: Model, action: Action): Result =>
  Option.exists(model.page, (page) => Predicate.isTagged(page, "JobsPage") && !page.resolvable)
    ? toast(model, { title: "Retry and discard aren’t available yet.", tone: "warning" })
    : mutate(model, action)

const unavailable = (model: Model, what: string): Result =>
  toast(model, { title: `${what} isn’t available yet`, tone: "warning" })

const savesToggle = (key: string): boolean =>
  Object.keys(toggleFields).includes(key) || parseNotificationKey(key) !== undefined

const savesChoice = (key: string): boolean =>
  Object.keys(choiceFields).includes(key) ||
  key === spendLimitKey ||
  parseMemberRoleKey(key) !== undefined

/** The command the send dialog holds, with its payload in the form the control plane compares. */
const commandInput = (model: Model) => ({
  command: (model.fields["command-name"] ?? "").trim(),
  payload: canonicalPayload(model.fields["command-payload"] ?? "{}"),
})

const sameInput = (
  sent: CommandSubmission,
  input: Readonly<{ command: string; payload: string }>,
): boolean => sent.command === input.command && sent.payload === input.payload

/**
 * The command ID the dialog's next send uses, or none when it mints a fresh one. A typed ID is
 * always used as typed, and a cleared field always mints. The ID the console generated for the last
 * send is reused only while the command and payload equal what was sent, compared the way the
 * control plane compares them, so a retry runs at most once and changed input is a new command.
 */
export const nextCommandId = (model: Model): Option.Option<string> => {
  const shown = (model.fields["command-id"] ?? "").trim()
  if (shown === "") return Option.none()
  const generated = Option.filter(
    model.commandSubmission,
    (sent) => sent.generated && sent.id === shown,
  )
  if (Option.isNone(generated) || sameInput(generated.value, commandInput(model)))
    return Option.some(shown)
  return Option.none()
}

/**
 * Whether the dialog's next send would repeat the submission that last failed in a way a retry
 * with the same command ID cannot fix, so sending it is not offered. Changed input or a cleared
 * command ID makes it a new submission.
 */
export const resendRefused = (model: Model): boolean =>
  Option.exists(model.commandError, ({ kind }) => !retryable(kind)) &&
  Option.exists(
    model.commandSubmission,
    (sent) =>
      Option.exists(nextCommandId(model), (id) => id === sent.id) &&
      sameInput(sent, commandInput(model)),
  )

/**
 * Sends the dialog's command with the ID `nextCommandId` chooses. Without one it asks for a fresh
 * ID first and the send resumes when it arrives; `minted` marks that ID as the console's own.
 */
const send = (
  model: Model,
  target: Readonly<{ address: string; scope: CommandScope }>,
  minted: boolean,
): Result => {
  if (
    !canSendCommand({ page: model.page, sample: model.pageSample }) ||
    model.loading ||
    model.sendingCommand ||
    resendRefused(model)
  )
    return { model }
  const chosen = minted
    ? Option.some((model.fields["command-id"] ?? "").trim())
    : nextCommandId(model)
  if (Option.isNone(chosen))
    return {
      model: {
        ...model,
        sendingCommand: true,
        commandAnswer: Option.none(),
        commandError: Option.none(),
        fields: { ...model.fields, "command-id": "" },
      },
      commands: [NewCommandId({ session: model.commandSession })],
    }
  const commandId = chosen.value
  const generated =
    minted ||
    Option.exists(model.commandSubmission, (sent) => sent.generated && sent.id === commandId)
  return {
    model: {
      ...model,
      sendingCommand: true,
      commandAnswer: Option.none(),
      commandError: Option.none(),
      commandSubmission: Option.some({ id: commandId, ...commandInput(model), generated }),
      fields: { ...model.fields, "command-id": commandId },
    },
    commands: [
      SendActorCommand({
        session: model.commandSession,
        address: target.address,
        scope: target.scope,
        command: (model.fields["command-name"] ?? "").trim(),
        payload: model.fields["command-payload"] ?? "{}",
        commandId,
      }),
    ],
  }
}

/**
 * Starts a rollback or redeploy unless one is already in flight, remembering the deployment page it
 * started from so a second click cannot send it twice.
 */
const changeDeployment = (model: Model, action: Action): Result => {
  if (Option.isSome(model.changingDeployment)) return { model }
  if (!canMutate({ page: model.page, sample: model.pageSample, loading: model.loading, action }))
    return mutate(model, action)
  return {
    model: { ...model, changingDeployment: Option.some(deploymentReference(model.route)) },
    commands: [Mutate({ action })],
  }
}

const deploymentReference = (route: AppRoute): string =>
  AppRoute.isAnyOf(["Deployment"])(route) ? route.deployment : ""

const deadLetterIds = (model: Model): ReadonlyArray<string> =>
  Option.match(model.page, {
    onNone: () => [],
    onSome: (page) =>
      Predicate.isTagged(page, "JobsPage") ? page.deadLetters.map((letter) => letter.id) : [],
  })

const confirm = (model: Model, dialog: Dialog): Result =>
  Match.value(dialog).pipe(
    Match.tagsExhaustive({
      DiscardDeadLetter: ({ id }) => resolveDeadLetters(model, Action.DiscardDeadLetter({ id })),
      RevokeKey: ({ name }) =>
        mutate(
          model,
          Action.RevokeKey({
            id: Option.match(settingsPage(model), {
              onNone: () => "",
              onSome: (page) => page.keys.find((key) => key.name === name)?.id ?? "",
            }),
            name,
          }),
        ),
      CreateKey: () => {
        const cleared = { ...model, fields: { ...model.fields, "key-name": "" } }
        return mutate(
          cleared,
          Action.CreateKey({
            name: model.fields["key-name"] ?? "",
            permission: model.choices["keyScope"] ?? "write",
            projectScoped: model.choices["keyProject"] !== "organization",
          }),
        )
      },
      AddVariable: () => {
        const cleared = {
          ...model,
          fields: { ...model.fields, "variable-name": "", "variable-value": "" },
        }
        return mutate(
          cleared,
          Action.SetVariable({
            environment: model.choices["variableEnvironment"] ?? "production",
            name: model.fields["variable-name"] ?? "",
            value: model.fields["variable-value"] ?? "",
          }),
        )
      },
      SendCommand: (target) => send(model, target, false),
      RollBack: ({ id, commit }) => changeDeployment(model, Action.RollBack({ id, commit })),
      Redeploy: ({ id, commit }) => changeDeployment(model, Action.Redeploy({ id, commit })),
      DeleteProject: ({ project }) => mutate(model, Action.DeleteProject({ slug: project })),
      KeyCreated: () => ({ model }),
    }),
  )

const minimumPassword = 12

const typed = (model: Model, name: string): string => (model.fields[name] ?? "").trim()

const pending = (model: Model, command: Result["commands"]): Result => ({
  model: { ...model, submitting: true, formError: Option.none() },
  commands: command,
})

const reject = (model: Model, message: string): Result => ({
  model: { ...model, formError: Option.some(message) },
})

const invitationId = (model: Model): string =>
  AppRoute.isAnyOf(["AcceptInvitation"])(model.route) ? model.route.invitation : ""

const deviceStep = (model: Model) =>
  Option.flatMap(model.page, (page) =>
    Predicate.isTagged(page, "DevicePage") ? Option.some(page.step) : Option.none(),
  )

/**
 * The device page's forms. A code is looked up only once it has the shape the CLI prints, and
 * Approve and Deny act only on a code a lookup confirmed, so a code that was never looked up, or
 * that the lookup refused, can't be approved even by a message that bypassed the view.
 */
const deviceForm = (model: Model, form: string): Result | undefined => {
  const step = deviceStep(model)
  const awaiting = (code: string, command: NonNullable<Result["commands"]>[number]): Result =>
    pending(
      {
        ...model,
        page: Option.some(
          DevicePage.make({
            step: Option.getOrElse(step, () => DeviceEntry.make({})),
            pending: code,
          }),
        ),
      },
      [command],
    )
  return Match.value(form).pipe(
    Match.when("device-code", () => {
      const linked = AppRoute.isAnyOf(["Device"])(model.route) ? model.route.user_code : undefined
      return Option.match(normalizeUserCode(model.fields["device-code"] ?? linked ?? ""), {
        onNone: () => reject(model, "Enter the code from your terminal. It looks like ABCD-EFGH."),
        onSome: (code) => awaiting(code, LookUpDevice({ code })),
      })
    }),
    Match.when("device-retry", () =>
      Option.match(Option.filter(step, S.is(DeviceRefused)), {
        onNone: () => ({ model }),
        onSome: ({ code }) => awaiting(code, LookUpDevice({ code })),
      }),
    ),
    Match.when("device-restart", () => ({
      model: {
        ...model,
        page: Option.some(DevicePage.make({ step: DeviceEntry.make({}) })),
        formError: Option.none(),
        fields: { ...model.fields, "device-code": "" },
      },
    })),
    Match.whenOr("device-approve", "device-deny", () =>
      Option.match(Option.filter(step, S.is(DeviceReview)), {
        onNone: () => ({ model }),
        onSome: ({ code }) =>
          awaiting(
            code,
            DecideDevice({ code, decision: form === "device-approve" ? "approved" : "denied" }),
          ),
      }),
    ),
    Match.orElse(() => undefined),
  )
}

const authForm = (model: Model, form: string): Result | undefined =>
  Match.value(form).pipe(
    Match.when("sign-in", () =>
      typed(model, "email") === "" || (model.fields["password"] ?? "") === ""
        ? reject(model, "Enter your email and password.")
        : pending(model, [
            SignIn({ email: typed(model, "email"), password: model.fields["password"] ?? "" }),
          ]),
    ),
    Match.when("sign-up", () => {
      const password = model.fields["new-password"] ?? ""
      if (typed(model, "name") === "" || typed(model, "email") === "")
        return reject(model, "Enter your name and email.")
      if (password.length < minimumPassword)
        return reject(model, `Use at least ${String(minimumPassword)} characters.`)
      return pending(model, [
        SignUp({ name: typed(model, "name"), email: typed(model, "email"), password }),
      ])
    }),
    Match.when("social-github", () => pending(model, [SignInWithProvider({ provider: "github" })])),
    Match.when("social-google", () => pending(model, [SignInWithProvider({ provider: "google" })])),
    Match.when("forgot", () =>
      typed(model, "email") === ""
        ? reject(model, "Enter the email you signed up with.")
        : pending(model, [RequestReset({ email: typed(model, "email") })]),
    ),
    Match.when("reset", () => {
      const password = model.fields["new-password"] ?? ""
      if (password.length < minimumPassword)
        return reject(model, `Use at least ${String(minimumPassword)} characters.`)
      if (password !== (model.fields["confirm-password"] ?? ""))
        return reject(model, "The two passwords don’t match.")
      return pending(model, [ResetPassword({ password })])
    }),
    Match.when("verify-resend", () =>
      typed(model, "email") === ""
        ? reject(model, "Enter your email on the sign-in page first.")
        : pending(model, [ResendVerification({ email: typed(model, "email") })]),
    ),
    Match.when("verify-continue", () => pending(model, [ContinueVerified()])),
    Match.when("accept-invitation", () =>
      pending(model, [AcceptInvitation({ id: invitationId(model) })]),
    ),
    Match.when("decline-invitation", () =>
      pending(model, [DeclineInvitation({ id: invitationId(model) })]),
    ),
    Match.when("onboarding-organization", () => {
      const name = typed(model, "org-name")
      if (name === "") return reject(model, "Name your organization.")
      return pending(model, [
        CreateOrganization({
          name,
          slug: typed(model, "org-slug") === "" ? slugify(name) : typed(model, "org-slug"),
        }),
      ])
    }),
    Match.when("onboarding-project", () => {
      const name = typed(model, "project-name")
      if (name === "") return reject(model, "Name your project.")
      return pending(model, [
        CreateProject({ name, region: model.choices["homeRegion"] ?? "us-east-1" }),
      ])
    }),
    Match.when("onboarding-deploy", () => {
      const slug = slugify(typed(model, "project-name"))
      return then(
        go(model, slug === "" ? Routes.overview() : Routes.project({ project: slug })),
        (next) => ({
          model: next,
          commands: [LoadWorkspace()],
        }),
      )
    }),
    Match.orElse(() => undefined),
  )

const submit = (model: Model, form: string): Result => {
  if (model.submitting) return { model }
  if (isAuthRoute(model.route) && model.pageSample)
    return reject(model, "Sample data is read-only.")
  const handled = authForm(model, form) ?? deviceForm(model, form)
  if (handled !== undefined) return handled
  return Match.value(form).pipe(
    Match.when("profile", () =>
      mutate(model, Action.UpdateProfile({ name: model.fields["display-name"] ?? "" })),
    ),
    Match.when("password", () =>
      mutate(model, Action.SendPasswordReset({ email: model.workspace.person.email })),
    ),
    Match.when("organization", () => {
      const page = settingsPage(model)
      const organization = Option.flatMap(page, (found) => Option.fromNullishOr(found.organization))
      return mutate(
        model,
        Action.UpdateOrganization({
          name:
            model.fields["org-name"] ??
            Option.match(organization, { onNone: () => "", onSome: (found) => found.name }),
          slug:
            model.fields["org-slug"] ??
            Option.match(organization, { onNone: () => "", onSome: (found) => found.slug }),
        }),
      )
    }),
    Match.when("invite-member", () => {
      const cleared = { ...model, fields: { ...model.fields, "invite-email": "" } }
      return mutate(
        cleared,
        Action.InviteMember({
          email: model.fields["invite-email"] ?? "",
          role: model.choices["inviteRole"] ?? "member",
        }),
      )
    }),
    Match.when("add-domain", () => {
      const cleared = { ...model, fields: { ...model.fields, domain: "" } }
      return mutate(
        cleared,
        Action.AddDomain({
          hostname: model.fields["domain"] ?? "",
          environment: model.choices["domain-environment"] ?? "production",
        }),
      )
    }),
    Match.when("change-plan", () => {
      const page = Option.getOrUndefined(settingsPage(model))
      const billing = page?.billing
      if (billing == null) return unavailable(model, "Another plan")
      const choices = planChoices({
        subscribed: billedPlan(billing)?.subscribed ?? null,
        plans: page?.plans ?? null,
      })
      const choice = choices.find(({ plan }) => plan === model.choices[planChoiceKey]) ?? choices[0]
      if (choice === undefined) return unavailable(model, "Another plan")
      const { plan, offer } = choice
      return mutate(
        model,
        hasPaidPlan(billing)
          ? Action.ChangePlan({ plan, name: offer.name })
          : Action.StartCheckout({ plan }),
      )
    }),
    Match.when("stripe-portal", () => mutate(model, Action.OpenBillingPortal())),
    Match.when("spend-limit", () =>
      mutate(
        model,
        Action.SaveChoice({ key: spendLimitKey, value: model.choices[spendLimitKey] ?? "" }),
      ),
    ),
    Match.orElse((name) => {
      const [prefix, id] = name.split(":")
      if (prefix === "resend-invite" && id !== undefined)
        return mutate(model, Action.ResendInvitation({ id }))
      if (prefix === "verify-domain" && id !== undefined)
        return mutate(model, Action.VerifyDomain({ id }))
      if (name.startsWith("add-region-"))
        return mutate(model, Action.AddRegion({ region: name.slice("add-region-".length) }))
      if (name.startsWith("connect-"))
        return mutate(model, Action.ConnectIntegration({ kind: name.slice("connect-".length) }))
      return unavailable(model, "That")
    }),
  )
}

const redirectFor = (kind: string): string | undefined =>
  Match.value(kind).pipe(
    Match.when("Unauthorized", () => Routes.signIn()),
    Match.when("SignedIn", () => Routes.overview()),
    Match.when("Onboarding", () => Routes.onboarding({})),
    Match.orElse(() => undefined),
  )

const step = (model: Model, message: Message): Result =>
  Message.match(message, {
    ChangedUrl: ({ url }) => {
      const route = Routes.parseUrl(url)
      const switchedProject =
        AppRoute.isAnyOf(["Project"])(route) && route.project !== currentProject(model)
      return {
        model: {
          ...model,
          route,
          changingDeployment: switchedProject ? Option.none() : model.changingDeployment,
          dialog: Option.none(),
          drawer: false,
          loading: true,
          tailStatus: "idle",
          tailSession: model.tailSession + 1,
          tailError: Option.none(),
          commandAnswer: Option.none(),
          commandError: Option.none(),
          commandSubmission: Option.none(),
          sendingCommand: false,
          commandSession: model.commandSession + 1,
          page: Option.none(),
          pageError: Option.none(),
          pageSample: false,
          formError: Option.none(),
          submitting: false,
          fields: Object.fromEntries(
            Object.entries(withoutPasswords(model.fields)).filter(
              ([name]) => name !== "device-code",
            ),
          ),
        },
        commands: [
          LoadPage({ route, allowSignIn: model.allowSignIn }),
          HidePopovers(),
          ...(Option.isSome(model.dialog) ? [HideDialog({ id: dialogId })] : []),
        ],
      }
    },
    RequestedUrl: ({ request }) =>
      Navigation.UrlRequest.match(request, {
        Internal: ({ url }): Result => go(model, toString(url)),
        External: ({ href }): Result => ({ model, commands: [LoadExternal({ href })] }),
      }),
    RequestedHref: ({ href }) => then(closePalette(model), (next) => go(next, href)),
    LoadedPage: ({ page, sample }) => {
      const seed = Option.match(page, {
        onNone: () => undefined,
        onSome: (loaded) =>
          Predicate.isTagged(loaded, "SettingsPage") ? settingsSeed(loaded) : undefined,
      })
      return {
        model: {
          ...model,
          page,
          pageError: Option.none(),
          pageSample: sample,
          allowSignIn: false,
          loading: false,
          tailSession: model.tailSession + 1,
          tailStatus:
            Option.exists(page, (loaded) => Predicate.isTagged(loaded, "CommandsPage")) && !sample
              ? "connecting"
              : "idle",
          tailError: Option.none(),
          toggles: { ...model.toggles, ...seed?.toggles },
          choices: {
            ...model.choices,
            ...Object.fromEntries(
              Object.entries(seed?.choices ?? {}).filter(([key]) => !environmentKeys.includes(key)),
            ),
          },
          tail: Option.match(page, {
            onNone: () => model.tail,
            onSome: (loaded) =>
              Predicate.isTagged(loaded, "CommandsPage")
                ? toOpeningTail(model.tail)(loaded.recent)
                : model.tail,
          }),
        },
      }
    },
    FailedPage: ({ kind, message }) => {
      const href = redirectFor(kind)
      if (href !== undefined)
        return {
          model: { ...model, loading: false, allowSignIn: kind === "Unauthorized" },
          commands: [ReplaceUrl({ href })],
        }
      return {
        model: { ...model, loading: false, pageError: Option.some({ kind, message }) },
      }
    },
    RetriedPage: () => ({
      model: { ...model, loading: true, pageError: Option.none() },
      commands: [LoadPage({ route: model.route, allowSignIn: model.allowSignIn }), LoadWorkspace()],
    }),
    LoadedWorkspace: ({ workspace }) => ({ model: { ...model, workspace } }),
    ToggledDrawer: () => ({ model: { ...model, drawer: !model.drawer } }),
    ClosedDrawer: () => ({ model: { ...model, drawer: false } }),
    OpenedPalette: () => (model.palette.open ? { model } : openPalette(model)),
    ToggledPalette: () => (model.palette.open ? closePalette(model) : openPalette(model)),
    ClosedPalette: () => closePalette(model),
    ChangedPaletteQuery: ({ query }) => {
      const next = { ...model, palette: { ...model.palette, query } }
      const first = paletteResults(next)[0]
      return {
        model: { ...next, palette: { ...next.palette, active: first?.id } },
        commands: query.trim() === "" ? [] : [SettlePaletteQuery({ query: query.trim() })],
      }
    },
    SettledPaletteQuery: ({ query }) =>
      model.palette.open && model.palette.query.trim() === query
        ? { model, commands: [SearchActors({ query })] }
        : { model },
    FoundActors: ({ query, actorTypes, actors }) => {
      const { found, active } = model.palette
      if (
        !model.palette.open ||
        !model.palette.query.trim().startsWith(query) ||
        (found !== undefined && query.length < found.query.length)
      )
        return { model }
      const next = { ...model, palette: { ...model.palette, found: { query, actorTypes, actors } } }
      const results = paletteResults(next)
      const chosen =
        active !== undefined &&
        active !== paletteResults(model)[0]?.id &&
        results.some((item) => item.id === active)
      return {
        model: { ...next, palette: { ...next.palette, active: chosen ? active : results[0]?.id } },
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
    ChangedField: ({ name, value }) => {
      const fields = { ...model.fields, [name]: value }
      if (name === "org-name" && model.fields["org-slug-edited"] !== "yes")
        fields["org-slug"] = slugify(value)
      if (name === "org-slug") fields["org-slug-edited"] = "yes"
      return { model: { ...model, fields } }
    },
    ToggledSetting: ({ key }) => {
      const enabled = model.toggles[key] !== true
      const next = { ...model, toggles: { ...model.toggles, [key]: enabled } }
      if (!savesToggle(key)) return { model: next }
      const action = Action.SaveToggle({ key, enabled })
      if (
        !canMutate({ page: model.page, sample: model.pageSample, loading: model.loading, action })
      )
        return mutate(model, action)
      return mutate(next, action)
    },
    ChoseSetting: ({ key, value }) => {
      const next = { ...model, choices: { ...model.choices, [key]: value } }
      if (key === spendLimitKey && refusesRightAway(model, value)) return { model: next }
      if (key === "seriesWindow" && ["1h", "24h", "7d"].includes(value))
        return model.pageSample
          ? { model }
          : { model: next, commands: [SelectSeriesWindow({ value })] }
      const action = Action.SaveChoice({ key, value })
      if (
        savesChoice(key) &&
        !canMutate({ page: model.page, sample: model.pageSample, loading: model.loading, action })
      )
        return mutate(model, action)
      const saves = savesChoice(key) ? [Mutate({ action })] : []
      if (!environmentKeys.includes(key) || !environments.some((name) => name === value))
        return { model: next, commands: saves }
      return {
        model: {
          ...next,
          choices: {
            ...next.choices,
            defaultEnvironment: value,
            environment: value,
            variableEnvironment: value,
          },
        },
        commands: [...saves, SelectEnvironment({ value })],
      }
    },
    ChangedSettingsQuery: ({ query }) => ({ model: { ...model, settingsQuery: query } }),
    SubmittedForm: ({ form }) => submit(model, form),
    OpenedDialog: ({ dialog }) =>
      then(closePalette(model), (next) => ({
        model: {
          ...next,
          dialog: Option.some(dialog),
          fields: Predicate.isTagged(dialog, "SendCommand")
            ? { ...next.fields, "command-id": "", "command-payload": "{}", "command-name": "" }
            : next.fields,
          commandAnswer: Option.none(),
          commandError: Option.none(),
          commandSubmission: Option.none(),
          sendingCommand: false,
          commandSession: next.commandSession + 1,
        },
        commands: [ShowDialog({ id: dialogId, focus: dialogFocus(dialog) })],
      })),
    ClosedDialog: () => ({
      model: {
        ...model,
        dialog: Option.none(),
        commandAnswer: Option.none(),
        commandError: Option.none(),
        commandSubmission: Option.none(),
        sendingCommand: false,
        commandSession: model.commandSession + 1,
      },
      commands: [
        HideDialog({ id: dialogId }),
        ...(Option.isSome(model.commandAnswer) &&
        Option.exists(
          model.page,
          (page) =>
            Predicate.isTagged(page, "MissingActorPage") ||
            (Predicate.isTagged(page, "ActorPage") && !model.pageSample),
        )
          ? [LoadPage({ route: model.route })]
          : []),
      ],
    }),
    ConfirmedDialog: () =>
      Option.match(model.dialog, {
        onNone: () => ({ model }),
        onSome: (dialog) =>
          Predicate.isTagged(dialog, "SendCommand")
            ? confirm(model, dialog)
            : then(
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
    ConnectedTail: ({ session }) =>
      session !== model.tailSession
        ? { model }
        : {
            model: { ...model, tailStatus: "live", tailError: Option.none() },
          },
    StreamedTurn: ({ session, entry }) =>
      session !== model.tailSession || model.tail.paused || model.pageSample
        ? { model }
        : {
            model: {
              ...model,
              tail: {
                ...model.tail,
                entries: [toTailEntry(model.tail.next)(entry), ...model.tail.entries].slice(0, 60),
                next: model.tail.next + 1,
              },
            },
          },
    StoppedTail: ({ session, kind, message }) => {
      if (session !== model.tailSession || !AppRoute.isAnyOf(["Commands"])(model.route))
        return { model }
      if (kind === "Unauthorized") return step(model, Message.FailedPage({ kind, message }))
      return {
        model: {
          ...model,
          tailStatus: kind === "NotImplemented" ? "unavailable" : "error",
          tailError: Option.some(message),
          tail: { ...model.tail, paused: true },
        },
      }
    },
    AnsweredCommand: ({ session, answer }) =>
      session !== model.commandSession
        ? { model }
        : {
            model: {
              ...model,
              sendingCommand: false,
              commandAnswer: Option.some(answer),
              commandError: Option.none(),
            },
          },
    FailedCommand: ({ session, kind, message }) => {
      if (session !== model.commandSession) return { model }
      if (kind === "Unauthorized") return step(model, Message.FailedPage({ kind, message }))
      return {
        model: { ...model, sendingCommand: false, commandError: Option.some({ kind, message }) },
      }
    },
    PreparedCommandId: ({ session, id }) => {
      if (session !== model.commandSession || (model.fields["command-id"] ?? "").trim() !== "")
        return { model }
      const prepared = { ...model, fields: { ...model.fields, "command-id": id } }
      return Option.match(model.dialog, {
        onNone: () => ({ model }),
        onSome: (dialog) =>
          model.sendingCommand && Predicate.isTagged(dialog, "SendCommand")
            ? send({ ...prepared, sendingCommand: false }, dialog, true)
            : { model: prepared },
      })
    },
    ToggledTail: () =>
      model.pageSample
        ? { model }
        : model.tail.paused
          ? {
              model: {
                ...model,
                loading: true,
                tailStatus: "connecting",
                tailError: Option.none(),
                tail: { ...model.tail, paused: false },
              },
              commands: [LoadPage({ route: model.route })],
            }
          : {
              model: {
                ...model,
                tailStatus: "paused",
                tailError: Option.none(),
                tail: { ...model.tail, paused: true },
              },
            },
    ChangedTailFilter: ({ filter }) => ({ model: { ...model, tail: { ...model.tail, filter } } }),
    RetriedDeadLetter: ({ id }) =>
      resolveDeadLetters(model, Action.RetryDeadLetters({ ids: [id] })),
    RetriedAllDeadLetters: () => {
      const open = deadLetterIds(model).filter((id) => !model.resolved.includes(id))
      return resolveDeadLetters(model, Action.RetryDeadLetters({ ids: open }))
    },
    Mutated: ({ title, description, reload }) =>
      then(toast(model, { title, description, tone: "live" }), (next) => ({
        model: next,
        commands: reload ? [LoadPage({ route: next.route }), LoadWorkspace()] : [],
      })),
    FailedMutation: ({ message }) =>
      then(toast(model, { title: message, tone: "danger" }), (next) => ({
        model: next,
        commands: isAuthRoute(next.route) ? [] : [LoadPage({ route: next.route })],
      })),
    ChangedDeployment: ({ href, title, description }) => {
      const settled = { ...model, changingDeployment: Option.none() }
      const stayed = Option.exists(
        model.changingDeployment,
        (from) => deploymentReference(model.route) === from,
      )
      const lists = AppRoute.isAnyOf(["Deployments", "Overview", "Project"])(model.route)
      return then(stayed ? go(settled, href) : { model: settled }, (moved) =>
        then(toast(moved, { title, description, tone: "live" }), (next) => ({
          model: next,
          commands: [
            LoadWorkspace(),
            ...(!stayed && lists ? [LoadPage({ route: next.route })] : []),
          ],
        })),
      )
    },
    FailedDeploymentChange: ({ message }) =>
      step({ ...model, changingDeployment: Option.none() }, Message.FailedMutation({ message })),
    CreatedKey: ({ name, secret }) =>
      then(
        {
          model: { ...model, dialog: Option.some(Dialog.KeyCreated({ name, secret })) },
          commands: [ShowDialog({ id: dialogId, focus: "[data-dialog-confirm]" })],
        },
        (next) => ({
          model: next,
          commands: [LoadPage({ route: next.route })],
        }),
      ),
    SignedOut: () =>
      then(closePalette({ ...model, changingDeployment: Option.none() }), (next) => ({
        model: next,
        commands: [SignOut()],
      })),
    CompletedAuth: ({ href, refresh, title, description }) =>
      then(
        {
          model: {
            ...model,
            submitting: false,
            formError: Option.none(),
            fields: withoutPasswords(model.fields),
            page: refresh ? Option.none() : model.page,
          },
          commands: refresh ? [LoadWorkspace()] : [],
        },
        (next) =>
          then(go(next, href), (arrived) =>
            title === undefined
              ? { model: arrived }
              : toast(arrived, { title, description, tone: "live" }),
          ),
      ),
    FailedAction: ({ message }) =>
      isAuthRoute(model.route)
        ? { model: { ...model, submitting: false, formError: Option.some(message) } }
        : toast({ ...model, submitting: false }, { title: message, tone: "danger" }),
    SentRecoveryEmail: () => ({
      model: {
        ...model,
        submitting: false,
        fields: { ...model.fields, recoverySent: "yes" },
      },
    }),
    ResentVerification: () =>
      toast(
        { ...model, submitting: false },
        {
          title: "Verification email sent",
          description: model.fields["email"] ?? "",
          tone: "live",
        },
      ),
    AnsweredDevice: ({ code, page }) =>
      AppRoute.isAnyOf(["Device"])(model.route) &&
      Option.exists(
        model.page,
        (open) => Predicate.isTagged(open, "DevicePage") && open.pending === code,
      )
        ? {
            model: {
              ...model,
              page: Option.some(page),
              submitting: false,
              formError: Option.none(),
            },
          }
        : { model },
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
