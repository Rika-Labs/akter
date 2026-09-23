import { Crypto, Effect } from "effect"
import { APIError } from "better-auth/api"
import { Auth } from "@durable-actors/accounts"
import { Billing } from "@durable-actors/billing"
import { Conflict, Forbidden, Unauthorized, Unavailable } from "@durable-actors/contracts"
import {
  billingFor,
  insertProject,
  membersFor,
  organizationFor,
  projectsFor,
} from "./repository.ts"

export const authenticated = Effect.fn("Api.authenticated")(function* () {
  const auth = yield* Auth

  const result = yield* auth
    .getSession()
    .pipe(Effect.mapError(() => Unavailable.make({ message: "Session lookup unavailable" })))

  if (result === null || !result.user.emailVerified)
    return yield* Unauthorized.make({ message: "Sign in with a verified email" })

  return result
})

export const activeOrganization = Effect.fn("Api.activeOrganization")(function* (
  admin: boolean = false,
) {
  const session = yield* authenticated()

  const org = yield* organizationFor(session.user.id, session.session.activeOrganizationId)

  if (org === null || (admin && !["owner", "admin"].includes(org.role)))
    return yield* Forbidden.make({ message: "Organization permission required" })

  return { session, org }
})

export const session = Effect.fn("Api.session")(function* () {
  const result = yield* authenticated()

  return {
    user: { id: result.user.id, name: result.user.name, email: result.user.email },
    activeOrganizationId: result.session.activeOrganizationId ?? null,
  }
})

export const dashboard = Effect.fn("Api.dashboard")(function* () {
  const result = yield* authenticated()

  const organization = yield* organizationFor(
    result.user.id,
    result.session.activeOrganizationId,
    true,
  )

  if (organization === null)
    return {
      user: result.user,
      organization: null,
      members: [],
      billing: { plan: "free" as const, status: "inactive" },
      projects: [],
    }

  const members = yield* membersFor(organization.id)
  const billing = yield* billingFor(organization.id)

  return {
    user: result.user,
    organization,
    members,
    billing:
      billing !== undefined
        ? {
            plan: billing.plan,
            status: billing.status,
            renewalDate: billing.renewalDate ?? undefined,
          }
        : { plan: "free" as const, status: "inactive" },
    projects: yield* projectsFor(organization.id),
  }
})

export const createOrganization = Effect.fn("Api.organization")(function* (
  payload: { readonly name: string; readonly slug: string },
  headers: Headers,
) {
  yield* authenticated()
  const raw = yield* (yield* Auth).auth

  const result = yield* Effect.tryPromise({
    try: () => raw.api.createOrganization({ body: payload, headers, returnHeaders: true }),
    catch: (error) =>
      error instanceof APIError &&
      error.statusCode === 400 &&
      error.body?.code === "ORGANIZATION_ALREADY_EXISTS"
        ? Conflict.make({ message: "Organization slug already exists" })
        : Unavailable.make({ message: "Organization creation unavailable" }),
  })

  const org = result.response

  const active = yield* Effect.tryPromise({
    try: () =>
      raw.api.setActiveOrganization({
        body: { organizationId: org.id },
        headers,
        returnHeaders: true,
      }),
    catch: () => Unavailable.make({ message: "Organization created; select it to continue" }),
  })

  return {
    organization: { id: org.id, name: org.name, slug: org.slug, role: "owner" as const },
    cookies: [...result.headers.getSetCookie(), ...active.headers.getSetCookie()],
  }
})

export const projects = Effect.fn("Api.projects")(function* () {
  const { org } = yield* activeOrganization()

  return yield* projectsFor(org.id)
})

export const createProject = Effect.fn("Api.createProject")(function* (name: string) {
  const { org, session } = yield* activeOrganization()
  const crypto = yield* Crypto.Crypto
  const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie)
  const project = yield* insertProject(id, org.id, session.user.id, name)

  if (project === undefined)
    return yield* Forbidden.make({ message: "Membership no longer exists" })

  return project
})

export const checkout = Effect.fn("Api.checkout")(function* () {
  const { org } = yield* activeOrganization(true)
  const billing = yield* Billing

  return yield* billing
    .checkout(org.id)
    .pipe(Effect.mapError((error) => Unavailable.make({ message: error.message })))
})

export const portal = Effect.fn("Api.portal")(function* () {
  const { org } = yield* activeOrganization(true)
  const billing = yield* Billing

  return yield* billing
    .portal(org.id)
    .pipe(Effect.mapError((error) => Unavailable.make({ message: error.message })))
})
