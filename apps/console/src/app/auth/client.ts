import { InvitationId, Name, RegionId, Slug } from "@akter/cloud-api"
import { Effect, Option, Schema as S } from "effect"
import {
  cloud,
  ConsoleError,
  consoleError,
  fixturesEnabled,
  load,
  type Loaded,
  organizationContext,
} from "../api/client.ts"
import { InvitationPage, slugify } from "./model.ts"
import { auth } from "./session.ts"

const capitalized = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`

/**
 * Loads the invitation the signed-in person was sent. An invitation that is no longer pending is
 * an error rather than a form that could not succeed. The plan catalog only names the plan, so an
 * unreadable catalog leaves its id to name it.
 */
export const loadInvitation = (id: string): Effect.Effect<Loaded<InvitationPage>, ConsoleError> =>
  load(
    Effect.gen(function* () {
      const api = yield* cloud
      const invitationId = yield* S.decodeEffect(InvitationId)(id)
      const preview = yield* api.invitations.preview({ params: { invitationId } })
      const catalog = yield* api.billing.listPlans().pipe(
        Effect.map(({ plans }) => plans.map(({ id, name }) => ({ id, name }))),
        Effect.orElseSucceed(() => []),
      )
      if (preview.status !== "pending")
        return yield* ConsoleError.make({
          kind: "Conflict",
          message: `This invitation was ${preview.status}. Ask for a new one.`,
        })
      return InvitationPage.make({
        id,
        organization: preview.organization.name,
        members: preview.organization.memberCount,
        plan: preview.organization.plan,
        catalog,
        inviter: preview.inviterName,
        email: preview.email,
        role: capitalized(preview.role),
      })
    }),
    () => import("./fixtures.ts").then((module) => module.invitation(id)),
  )

const sample = ConsoleError.make({ kind: "Sample", message: "Sample data is read-only." })

const live = <A, E>(real: Effect.Effect<A, E>): Effect.Effect<A, ConsoleError> =>
  Effect.suspend(() =>
    fixturesEnabled() ? Effect.fail(sample) : real.pipe(Effect.mapError(consoleError)),
  )

const invalid = (message: string) => ConsoleError.make({ kind: "Invalid", message })

const parse = <A>(
  schema: S.Codec<A, string>,
  value: string,
  message: string,
): Effect.Effect<A, ConsoleError> =>
  S.decodeEffect(schema)(value).pipe(Effect.mapError(() => invalid(message)))

const nameMessage = "Use a name of 1 to 100 characters without leading or trailing spaces."
const slugMessage = "Use lowercase letters, digits and hyphens for the URL, up to 40 characters."

/** Signs in with email and password; an unverified address fails with kind `EMAIL_NOT_VERIFIED`. */
export const signInEmail = (input: Readonly<{ email: string; password: string }>) =>
  live(auth.signInEmail(input).pipe(Effect.asVoid))

/** Creates an account; `verified` is false while the address still has to be confirmed. */
export const signUpEmail = (input: Readonly<{ name: string; email: string; password: string }>) =>
  live(auth.signUpEmail(input).pipe(Effect.map((data) => ({ verified: data.user.emailVerified }))))

/** The provider's authorization URL, which the page then opens. */
export const socialUrl = (provider: "github" | "google") => live(auth.signInSocial(provider))

/** Sends another verification email. */
export const resendVerification = (email: string) =>
  live(auth.sendVerificationEmail(email).pipe(Effect.asVoid))

/** Whether the signed-in person has verified their address since the last check. */
export const checkVerified = live(
  auth.session.pipe(
    Effect.flatMap((session) =>
      Option.exists(session, (user) => user.emailVerified)
        ? Effect.void
        : Effect.fail(
            invalid(
              "We haven’t seen your address verified yet. Open the link we emailed you on this device.",
            ),
          ),
    ),
  ),
)

/** Emails a reset link; the answer never says whether the address has an account. */
export const requestReset = (email: string) =>
  live(auth.requestPasswordReset(email).pipe(Effect.asVoid))

/** Sets a new password from the token the emailed link carried in the page's query. */
export const resetPassword = (newPassword: string) =>
  live(
    Effect.suspend(() => {
      const query = new URLSearchParams(location.search)
      const token = query.get("token")
      if (token === null || query.has("error"))
        return Effect.fail(invalid("This reset link is invalid or has expired. Request a new one."))
      return auth.resetPassword({ newPassword, token }).pipe(Effect.asVoid)
    }),
  )

/** Ends the session. */
export const signOut = live(auth.signOut.pipe(Effect.asVoid))

/** Creates the organization and makes it the active one. */
export const createOrganization = ({ name, slug }: Readonly<{ name: string; slug: string }>) =>
  live(
    Effect.gen(function* () {
      const payload = {
        name: yield* parse(Name, name, nameMessage),
        slug: yield* parse(Slug, slug, slugMessage),
      }
      const api = yield* cloud
      const membership = yield* api.organizations.create({ payload })
      yield* api.account.setActiveOrganization({
        payload: { organizationId: membership.organization.id },
      })
    }),
  )

/** Creates a project in the active organization. */
export const createProject = ({ name, region }: Readonly<{ name: string; region: string }>) =>
  live(
    Effect.gen(function* () {
      const payload = {
        name: yield* parse(Name, name, nameMessage),
        slug: yield* parse(Slug, slugify(name), slugMessage),
        homeRegion: yield* parse(RegionId, region, "Choose one of the offered regions."),
      }
      const api = yield* cloud
      const { organization } = yield* organizationContext
      yield* api.projects.create({ params: { organizationId: organization.id }, payload })
    }),
  )

/** Accepts the invitation and reports which organization and role it granted. */
export const acceptInvitation = (id: string) =>
  live(
    Effect.gen(function* () {
      const api = yield* cloud
      const invitationId = yield* S.decodeEffect(InvitationId)(id)
      const membership = yield* api.invitations.accept({ params: { invitationId } })
      return { organization: membership.organization.name, role: capitalized(membership.role) }
    }),
  )

/** Declines the invitation. */
export const declineInvitation = (id: string) =>
  live(
    Effect.gen(function* () {
      const api = yield* cloud
      const invitationId = yield* S.decodeEffect(InvitationId)(id)
      yield* api.invitations.decline({ params: { invitationId } })
    }),
  )
