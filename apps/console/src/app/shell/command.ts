import { closeDialog, openDialog } from "@akter/ui"
import { Cause, Duration, Effect, Match, Option, Predicate, Schema as S } from "effect"
import * as Command from "foldkit/command"
import * as Navigation from "foldkit/navigation"
import {
  EnvironmentName,
  IntegrationKind,
  InviteRole,
  RegionId,
  ApiKeyPermission,
} from "@akter/cloud-api"
import {
  ConsoleError,
  fixturesEnabled,
  rememberAuthReturn,
  signInDestination,
  newCommandId,
} from "../api/client.ts"
import * as Auth from "../auth/client.ts"
import { AppRoute } from "../navigation/routes.ts"
import * as Routes from "../navigation/routes.ts"
import { discardDeadLetter, retryDeadLetter } from "../jobs/client.ts"
import { redeployDeployment, rollBackDeployment } from "../deployments/client.ts"
import { sendCommand } from "../commands/client.ts"
import { CommandScope } from "../commands/model.ts"
import { searchActors } from "../actors/client.ts"
import * as Settings from "../settings/client.ts"
import { titleCase } from "../settings/format.ts"
import { spendLimitKey } from "../settings/keys.ts"
import type { PaidPlan } from "../settings/model.ts"
import { loadWorkspace } from "../workspace/client.ts"
import { Action } from "./action.ts"
import {
  CompletedAuth,
  CompletedEffect,
  CreatedKey,
  DismissedToast,
  FailedAction,
  FailedMutation,
  ChangedDeployment,
  FailedDeploymentChange,
  AnsweredCommand,
  FailedCommand,
  PreparedCommandId,
  Mutated,
  FailedPage,
  FoundActors,
  LoadedPage,
  LoadedWorkspace,
  ResentVerification,
  RetriedPage,
  SentRecoveryEmail,
} from "./message.ts"
import { loadPage } from "./page.ts"
import { applyPreference, Preference } from "./theme.ts"

/**
 * Loads the open route's data through its client. A failure becomes a message so the shell can
 * redirect or show it, never an unhandled error; an `Unauthorized` one first remembers the page so
 * signing in can return to it. `allowSignIn` lets the sign-in screen open despite a live session.
 */
export const LoadPage = Command.define("LoadPage", {
  args: { route: AppRoute, allowSignIn: S.optional(S.Boolean) },
  messages: [LoadedPage, FailedPage],
  execute: ({ route, allowSignIn }) =>
    loadPage({ route, allowSignIn: allowSignIn ?? false }).pipe(
      Effect.map(({ data, sample }) => LoadedPage({ page: data, sample })),
      Effect.tapError((error) =>
        error.kind === "Unauthorized" ? Effect.sync(rememberAuthReturn) : Effect.void,
      ),
      Effect.catch((error) =>
        Effect.succeed(FailedPage({ kind: error.kind, message: error.message })),
      ),
    ),
})

/** Loads the signed-in workspace again, or the empty one once the session is gone. */
export const LoadWorkspace = Command.define("LoadWorkspace", {
  messages: [LoadedWorkspace],
  execute: loadWorkspace.pipe(Effect.map((workspace) => LoadedWorkspace({ workspace }))),
})

/** Moves to another console URL without reloading. */
export const PushUrl = Command.define("PushUrl", {
  args: { href: S.String },
  messages: [CompletedEffect],
  execute: ({ href }) => Navigation.pushUrl(href).pipe(Effect.as(CompletedEffect())),
})

/** Replaces the current history entry, so a redirect does not trap the back button. */
export const ReplaceUrl = Command.define("ReplaceUrl", {
  args: { href: S.String },
  messages: [CompletedEffect],
  execute: ({ href }) => Navigation.replaceUrl(href).pipe(Effect.as(CompletedEffect())),
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

type Outcome = ReturnType<typeof CompletedAuth> | ReturnType<typeof FailedAction>

const failed = (error: ConsoleError): Effect.Effect<ReturnType<typeof FailedAction>> =>
  Effect.succeed(FailedAction({ message: error.message }))

const completed = (
  href: string,
  refresh: boolean,
): Effect.Effect<ReturnType<typeof CompletedAuth>> =>
  Effect.succeed(CompletedAuth({ href, refresh }))

/** Signs in with email and password; an unverified address continues on the verify screen. */
export const SignIn = Command.define("SignIn", {
  args: { email: S.String, password: S.String },
  messages: [CompletedAuth, FailedAction],
  execute: ({ email, password }) =>
    Auth.signInEmail({ email, password }).pipe(
      Effect.flatMap(() => completed(signInDestination(Routes.overview()), true)),
      Effect.catch((error): Effect.Effect<Outcome> =>
        error.kind === "EMAIL_NOT_VERIFIED"
          ? completed(Routes.verifyEmail(), false)
          : failed(error),
      ),
    ),
})

/** Creates an account and continues on the verify screen, or onboarding when no check is needed. */
export const SignUp = Command.define("SignUp", {
  args: { name: S.String, email: S.String, password: S.String },
  messages: [CompletedAuth, FailedAction],
  execute: (input) =>
    Auth.signUpEmail(input).pipe(
      Effect.flatMap(({ verified }) =>
        completed(verified ? Routes.onboarding({}) : Routes.verifyEmail(), verified),
      ),
      Effect.catch(failed),
    ),
})

/** Continues with GitHub or Google by opening the provider's authorization page. */
export const SignInWithProvider = Command.define("SignInWithProvider", {
  args: { provider: S.Literals(["github", "google"]) },
  messages: [CompletedAuth, FailedAction, CompletedEffect],
  execute: ({ provider }) =>
    Auth.socialUrl(provider).pipe(
      Effect.flatMap((url) => Navigation.load(url).pipe(Effect.as(CompletedEffect()))),
      Effect.catch(failed),
    ),
})

/** Sends another verification email. */
export const ResendVerification = Command.define("ResendVerification", {
  args: { email: S.String },
  messages: [ResentVerification, FailedAction],
  execute: ({ email }) =>
    Auth.resendVerification(email).pipe(Effect.as(ResentVerification()), Effect.catch(failed)),
})

/** Continues to onboarding once the session shows the address as verified. */
export const ContinueVerified = Command.define("ContinueVerified", {
  messages: [CompletedAuth, FailedAction],
  execute: Auth.checkVerified.pipe(
    Effect.andThen(completed(Routes.onboarding({}), true)),
    Effect.catch(failed),
  ),
})

/** Emails a password reset link. */
export const RequestReset = Command.define("RequestReset", {
  args: { email: S.String },
  messages: [SentRecoveryEmail, FailedAction],
  execute: ({ email }) =>
    Auth.requestReset(email).pipe(Effect.as(SentRecoveryEmail()), Effect.catch(failed)),
})

/** Saves a new password with the token from the emailed link. */
export const ResetPassword = Command.define("ResetPassword", {
  args: { password: S.String },
  messages: [CompletedAuth, FailedAction],
  execute: ({ password }) =>
    Auth.resetPassword(password).pipe(
      Effect.as(
        CompletedAuth({
          href: Routes.signIn(),
          refresh: false,
          title: "Password updated",
          description: "Sign in with your new password.",
        }),
      ),
      Effect.catch(failed),
    ),
})

/** Ends the session and returns to sign-in. */
export const SignOut = Command.define("SignOut", {
  messages: [CompletedAuth, FailedAction],
  execute: Auth.signOut.pipe(
    Effect.andThen(completed(Routes.signIn(), true)),
    Effect.catch(failed),
  ),
})

/** Creates the organization onboarding asked for. */
export const CreateOrganization = Command.define("CreateOrganization", {
  args: { name: S.String, slug: S.String },
  messages: [CompletedAuth, FailedAction],
  execute: ({ name, slug }) =>
    Auth.createOrganization({ name, slug }).pipe(
      Effect.andThen(completed(Routes.onboarding({ step: "project" }), true)),
      Effect.catch(failed),
    ),
})

/** Creates the project onboarding asked for, in its home region. */
export const CreateProject = Command.define("CreateProject", {
  args: { name: S.String, region: S.String },
  messages: [CompletedAuth, FailedAction],
  execute: ({ name, region }) =>
    Auth.createProject({ name, region }).pipe(
      Effect.andThen(completed(Routes.onboarding({ step: "deploy" }), true)),
      Effect.catch(failed),
    ),
})

/** Accepts an invitation and enters the organization it names. */
export const AcceptInvitation = Command.define("AcceptInvitation", {
  args: { id: S.String },
  messages: [CompletedAuth, FailedAction],
  execute: ({ id }) =>
    Auth.acceptInvitation(id).pipe(
      Effect.map(({ organization, role }) =>
        CompletedAuth({
          href: Routes.overview(),
          refresh: true,
          title: `Welcome to ${organization}`,
          description: `You joined as a ${role}.`,
        }),
      ),
      Effect.catch(failed),
    ),
})

/** Declines an invitation. */
export const DeclineInvitation = Command.define("DeclineInvitation", {
  args: { id: S.String },
  messages: [CompletedAuth, FailedAction],
  execute: ({ id }) =>
    Auth.declineInvitation(id).pipe(
      Effect.andThen(completed(Routes.overview(), true)),
      Effect.catch(failed),
    ),
})

/**
 * Remembers the chosen environment for this tab, then asks the shell to reload the page and the
 * workspace, which belong to one environment.
 */
export const SelectEnvironment = Command.define("SelectEnvironment", {
  args: { value: S.String },
  messages: [RetriedPage],
  execute: ({ value }) =>
    Effect.try(() => window.sessionStorage.setItem("console-environment", value)).pipe(
      Effect.ignore,
      Effect.as(RetriedPage()),
    ),
})

/** Searches actor addresses that start with what the palette holds; a failed search finds none. */
export const SearchActors = Command.define("SearchActors", {
  args: { query: S.String },
  messages: [FoundActors],
  execute: ({ query }) =>
    searchActors(query).pipe(Effect.map((actors) => FoundActors({ query, actors }))),
})

/** Persists the requested chart window before reloading its endpoint data. */
export const SelectSeriesWindow = Command.define("SelectSeriesWindow", {
  args: { value: S.String },
  messages: [RetriedPage],
  execute: ({ value }) =>
    Effect.try(() => sessionStorage.setItem("console-series-window", value)).pipe(
      Effect.ignore,
      Effect.as(RetriedPage()),
    ),
})

/** Sends a command without closing the dialog so its result or typed refusal stays visible. */
export const SendActorCommand = Command.define("SendActorCommand", {
  args: {
    session: S.Finite,
    scope: CommandScope,
    address: S.String,
    command: S.String,
    payload: S.String,
    commandId: S.String.pipe(S.check(S.isMinLength(1))),
  },
  messages: [AnsweredCommand, FailedCommand],
  execute: (request) =>
    sendCommand(request).pipe(
      Effect.map((answer) => AnsweredCommand({ session: request.session, answer })),
      Effect.catch((error) =>
        Effect.succeed(
          FailedCommand({ session: request.session, kind: error.kind, message: error.message }),
        ),
      ),
    ),
})

/** Mints the command ID of a new submission; retrying that submission reuses it, so it runs at most once. */
export const NewCommandId = Command.define("NewCommandId", {
  args: { session: S.Finite },
  messages: [PreparedCommandId, FailedCommand],
  execute: ({ session }) =>
    newCommandId.pipe(
      Effect.map((id) => PreparedCommandId({ session, id })),
      Effect.catch((error) =>
        Effect.succeed(FailedCommand({ session, kind: error.kind, message: error.message })),
      ),
    ),
})

const invalid = (message: string) => ConsoleError.make({ kind: "Invalid", message })

const choose = <A>(schema: S.Codec<A, string>, value: string, message: string) =>
  S.decodeEffect(schema)(value).pipe(Effect.mapError(() => invalid(message)))

type Settled =
  | ReturnType<typeof Mutated>
  | ReturnType<typeof ChangedDeployment>
  | ReturnType<typeof CreatedKey>
  | ReturnType<typeof CompletedAuth>
  | ReturnType<typeof CompletedEffect>

const done = (title: string, description?: string, reload = true): Effect.Effect<Settled> =>
  Effect.succeed(Mutated({ title, description, reload }))

const leave = (url: string): Effect.Effect<Settled> =>
  Navigation.load(url).pipe(Effect.as(CompletedEffect()))

/**
 * Opens a hosted page in a new tab. The tab opens before its URL is fetched, while the click still
 * counts as user activation, so the browser does not block it as a popup; it closes again when no
 * URL comes back. A browser that refuses the tab gets the page in this one instead.
 */
const leaveInNewTab = (
  hosted: Effect.Effect<{ readonly url: string }, ConsoleError>,
): Effect.Effect<Settled, ConsoleError> =>
  Effect.suspend(() => {
    const tab = window.open("", "_blank")
    if (tab === null) return hosted.pipe(Effect.flatMap(({ url }) => leave(url)))
    tab.opener = null
    return hosted.pipe(
      Effect.tap(({ url }) => Effect.sync(() => tab.location.replace(url))),
      Effect.as(CompletedEffect()),
      Effect.tapError(() => Effect.sync(() => tab.close())),
    )
  })

const planChanged = (
  plan: PaidPlan,
  status: Effect.Success<ReturnType<typeof Settings.changePlan>>,
): Effect.Effect<Settled, ConsoleError> => {
  const name = titleCase(plan)
  if (status === "completed") return done(`You’re on ${name} now`)
  if (status === "pending")
    return done(`Changing to ${name}`, `${name} applies once the payment goes through.`)
  return Effect.fail(
    ConsoleError.make({
      kind: "Conflict",
      message: `The change to ${name} didn’t go through; your plan is unchanged.`,
    }),
  )
}

const perform = (action: Action): Effect.Effect<Settled, ConsoleError> =>
  Match.value(action).pipe(
    Match.tagsExhaustive({
      SaveToggle: ({ key, enabled }) =>
        Settings.saveToggle({ key, enabled }).pipe(Effect.as(CompletedEffect())),
      SaveChoice: ({ key, value }) =>
        Settings.saveChoice({ key, value }).pipe(
          Effect.andThen(
            key === spendLimitKey ? done("Spend limit saved") : Effect.succeed(CompletedEffect()),
          ),
        ),
      UpdateProfile: ({ name }) =>
        Settings.updateProfile({ name: name.trim() }).pipe(Effect.andThen(done("Profile saved"))),
      SendPasswordReset: ({ email }) =>
        Auth.requestReset(email).pipe(
          Effect.andThen(done("Reset link sent", `Check ${email} for the link.`, false)),
        ),
      UpdateOrganization: ({ name, slug }) =>
        Settings.updateOrganization({ name: name.trim(), slug: slug.trim() }).pipe(
          Effect.andThen(done("Organization saved")),
        ),
      InviteMember: ({ email, role }) =>
        choose(InviteRole, role, "Choose a role for the invitation.").pipe(
          Effect.flatMap((granted) =>
            Settings.inviteMember({ email: email.trim(), role: granted }),
          ),
          Effect.andThen(done(`Invitation sent to ${email.trim()}`)),
        ),
      ResendInvitation: ({ id }) =>
        Settings.resendInvitation(id).pipe(Effect.andThen(done("Invitation sent again"))),
      AddDomain: ({ hostname, environment }) =>
        choose(EnvironmentName, environment, "Choose an environment.").pipe(
          Effect.flatMap((chosen) =>
            Settings.addDomain({ hostname: hostname.trim().toLowerCase(), environment: chosen }),
          ),
          Effect.andThen(done(`Added ${hostname.trim()}`, "Waiting for its CNAME record.")),
        ),
      VerifyDomain: ({ id }) =>
        Settings.verifyDomain(id).pipe(Effect.andThen(done("Checked the DNS records"))),
      AddRegion: ({ region }) =>
        choose(RegionId, region, "Choose one of the offered regions.").pipe(
          Effect.flatMap(Settings.addRegion),
          Effect.andThen(done(`Added ${region}`)),
        ),
      ConnectIntegration: ({ kind }) =>
        choose(IntegrationKind, kind, "That integration isn’t offered.").pipe(
          Effect.flatMap((chosen) => Settings.connectIntegration({ kind: chosen })),
          Effect.flatMap(({ redirectUrl }) =>
            redirectUrl === null ? done(`Connected ${kind}`) : leave(redirectUrl),
          ),
        ),
      StartCheckout: ({ plan }) =>
        Settings.startCheckout(plan).pipe(Effect.flatMap(({ url }) => leave(url))),
      ChangePlan: ({ plan }) =>
        Settings.changePlan(plan).pipe(Effect.flatMap((status) => planChanged(plan, status))),
      OpenBillingPortal: () => leaveInNewTab(Settings.openBillingPortal),
      SetVariable: ({ environment, name, value }) =>
        choose(EnvironmentName, environment, "Choose an environment.").pipe(
          Effect.flatMap((chosen) =>
            Settings.setEnvironmentVariable({ environment: chosen, name: name.trim(), value }),
          ),
          Effect.andThen(done(`Saved ${name.trim()}`, "It takes effect on the next deploy.")),
        ),
      CreateKey: ({ name, permission, projectScoped }) =>
        choose(ApiKeyPermission, permission, "Choose what the key may do.").pipe(
          Effect.flatMap((chosen) =>
            Settings.createApiKey({ name: name.trim(), permission: chosen, projectScoped }),
          ),
          Effect.map((created) => CreatedKey(created)),
        ),
      RevokeKey: ({ id, name }) =>
        Settings.revokeApiKey(id).pipe(
          Effect.andThen(done(`Revoked ${name}`, "Requests using it now fail.")),
        ),
      DeleteProject: ({ slug }) =>
        Settings.deleteProject.pipe(
          Effect.as(
            CompletedAuth({
              href: Routes.overview(),
              refresh: true,
              title: `${slug} scheduled for deletion`,
              description: "Runners stop now; the database is kept for 7 days.",
            }),
          ),
        ),
      RetryDeadLetters: ({ ids }) =>
        Effect.forEach(ids, retryDeadLetter, { discard: true }).pipe(
          Effect.andThen(
            done(
              ids.length === 1
                ? `Retrying ${ids[0] ?? "job"}`
                : `Retrying ${String(ids.length)} jobs`,
            ),
          ),
        ),
      DiscardDeadLetter: ({ id }) =>
        discardDeadLetter(id).pipe(
          Effect.andThen(done(`Discarded ${id}`, "The job will not run again.")),
        ),
      RollBack: ({ id }) =>
        rollBackDeployment(id).pipe(
          Effect.map(({ deploy }) =>
            ChangedDeployment({
              href: Routes.deployment({ deployment: deploy.id }),
              title: deploy.message,
              description: "Rolling out now. The live deployment keeps serving until it’s live.",
            }),
          ),
        ),
      Redeploy: ({ id }) =>
        redeployDeployment(id).pipe(
          Effect.map((deploy) =>
            ChangedDeployment({
              href: Routes.deployment({ deployment: deploy.id }),
              title: deploy.message,
              description: "The new deployment is building.",
            }),
          ),
        ),
    }),
  )

/**
 * Runs one change through the cloud API; a refusal becomes a message the shell shows, never a silent
 * success. Every other ending, a defect or an interruption inside the change included, is reported
 * too, and a rollback or redeploy that did not succeed has its own message, so the shell always
 * releases the deployment change it was holding.
 */
export const Mutate = Command.define("Mutate", {
  args: { action: Action },
  messages: [
    Mutated,
    ChangedDeployment,
    CreatedKey,
    CompletedAuth,
    CompletedEffect,
    FailedMutation,
    FailedDeploymentChange,
  ],
  execute: ({ action }) =>
    Effect.suspend(() =>
      fixturesEnabled()
        ? Effect.fail(ConsoleError.make({ kind: "Sample", message: "Sample data is read-only." }))
        : perform(action),
    ).pipe(
      Effect.catchCause((cause) => {
        const message = Option.match(Cause.findErrorOption(cause), {
          onNone: () => "The change didn’t finish. Reload to see where it stands.",
          onSome: (error) => error.message,
        })
        return Effect.succeed(
          Predicate.isTagged(action, "RollBack") || Predicate.isTagged(action, "Redeploy")
            ? FailedDeploymentChange({ message })
            : FailedMutation({ message }),
        )
      }),
    ),
})
