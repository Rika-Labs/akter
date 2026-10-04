import * as Cloud from "@akter/cloud-api"
import { Clock, DateTime, Effect, Layer, Match, Option, Predicate, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { Access } from "./access.ts"
import { Auth } from "./auth.ts"
import { Repository } from "./repository.ts"
import { BillingActor } from "./billing-actor.ts"

const timestamp = (date: Date | string) => DateTime.makeUnsafe(date)
const headers = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) => new Headers(request.headers),
)
const authCall = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: () => Cloud.Conflict.make({ message: "The account operation was refused" }),
  })

interface OrganizationRow {
  id: string
  name: string
  slug: string
  createdAt: Date
}
interface MemberRow {
  id: string
  userId: string
  name: string
  email: string
  image: string | null
  role: string
  createdAt: Date
}
interface InvitationRow {
  id: string
  organizationId: string
  email: string
  role: string
  status: string
  inviterId: string
  inviterName: string
  createdAt: Date
  expiresAt: Date
}
interface KeyRow {
  id: string
  organization_id: string
  name: string
  prefix: string
  last_four: string
  permission: string
  project_id: string | null
  created_at: Date
  created_by: string
  last_used_at: Date | null
  expires_at: Date | null
  revoked_at: Date | null
}

const organization = (row: OrganizationRow) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [billing] = yield* sql<{ readonly plan: string }>`
    SELECT plan FROM cloud_billing_account WHERE organization_id = ${row.id}
  `.pipe(Effect.orDie)
    return yield* Schema.decodeUnknownEffect(Schema.toType(Cloud.Organization))({
      ...row,
      plan: billing?.plan ?? "free",
      createdAt: timestamp(row.createdAt),
    }).pipe(Effect.orDie)
  })
const member = (row: MemberRow) =>
  Schema.decodeUnknownEffect(Schema.toType(Cloud.Member))({
    id: row.id,
    user: { id: row.userId, name: row.name, email: row.email, image: row.image },
    role: row.role,
    createdAt: timestamp(row.createdAt),
    lastActiveAt: null,
  }).pipe(Effect.orDie)
const invitation = Effect.fn(function* (row: InvitationRow) {
  const now = yield* Clock.currentTimeMillis
  return yield* Schema.decodeUnknownEffect(Schema.toType(Cloud.Invitation))({
    ...row,
    invitedBy: { id: row.inviterId, name: row.inviterName },
    status:
      row.status === "rejected"
        ? "declined"
        : row.status === "pending" && row.expiresAt.getTime() < now
          ? "expired"
          : row.status,
    createdAt: timestamp(row.createdAt),
    expiresAt: timestamp(row.expiresAt),
  }).pipe(Effect.orDie)
})
const key = (row: KeyRow) =>
  Schema.decodeUnknownEffect(Schema.toType(Cloud.ApiKey))({
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    prefix: row.prefix,
    lastFour: row.last_four,
    permission: row.permission,
    projectId: row.project_id,
    createdAt: timestamp(row.created_at),
    createdBy: { kind: "user", id: row.created_by, name: null },
    lastUsedAt: row.last_used_at === null ? null : timestamp(row.last_used_at),
    expiresAt: row.expires_at === null ? null : timestamp(row.expires_at),
    revokedAt: row.revoked_at === null ? null : timestamp(row.revoked_at),
  }).pipe(Effect.orDie)

const services = Effect.gen(function* () {
  const auth = yield* Auth
  const access = yield* Access
  const sql = yield* SqlClient.SqlClient
  const repository = yield* Repository
  const memberships = Effect.gen(function* () {
    const caller = yield* Cloud.CurrentIdentity
    if (Predicate.isTagged(caller, "api-key")) {
      const rows =
        yield* sql<OrganizationRow>`SELECT * FROM organization WHERE id = ${caller.organizationId}`.pipe(
          Effect.orDie,
        )
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          return yield* Schema.decodeUnknownEffect(Schema.toType(Cloud.OrganizationMembership))({
            organization: yield* organization(row),
            role: Match.value(caller.permission).pipe(
              Match.when("admin", () => "admin"),
              Match.when("write", () => "member"),
              Match.orElse(() => "viewer"),
            ),
          }).pipe(Effect.orDie)
        }),
      )
    }
    const rows = yield* sql<
      OrganizationRow & { role: string }
    >`SELECT o.*, m.role FROM organization o JOIN member m ON m."organizationId" = o.id WHERE m."userId" = ${caller.userId} ORDER BY o."createdAt"`.pipe(
      Effect.orDie,
    )
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        return yield* Schema.decodeUnknownEffect(Schema.toType(Cloud.OrganizationMembership))({
          organization: yield* organization(row),
          role: row.role,
        }).pipe(Effect.orDie)
      }),
    )
  })
  const getOrganization = Effect.fn("Accounts.organization")(function* (id: string) {
    const permission = yield* access.organization(id)
    const [row] = yield* sql<OrganizationRow>`SELECT * FROM organization WHERE id = ${id}`.pipe(
      Effect.orDie,
    )
    if (row === undefined) return yield* Cloud.NotFound.make({ resource: "organization", id })
    return yield* Schema.decodeUnknownEffect(Schema.toType(Cloud.OrganizationMembership))({
      organization: yield* organization(row),
      role: Match.value(permission.role).pipe(
        Match.when("read", () => "viewer"),
        Match.when("write", () => "member"),
        Match.orElse((role) => role),
      ),
    }).pipe(Effect.orDie)
  })
  const audit = Effect.fn("Accounts.audit")(function* (
    organizationId: string,
    action: string,
    target: string,
  ) {
    const caller = yield* Cloud.CurrentIdentity
    const request = yield* HttpServerRequest.HttpServerRequest
    yield* repository.recordAudit({
      organizationId,
      actor: {
        kind: Predicate.isTagged(caller, "session") ? "user" : "api-key",
        id: Predicate.isTagged(caller, "session") ? caller.userId : caller.keyId,
      },
      action,
      target: { type: action.split(".")[0] ?? "account", id: target },
      ip: Option.getOrUndefined(request.remoteAddress),
    })
  })
  const getInvitation = Effect.fn("Accounts.invitation")(function* (id: string) {
    const [row] =
      yield* sql<InvitationRow>`SELECT i.*, u.name AS "inviterName" FROM invitation i JOIN "user" u ON u.id = i."inviterId" WHERE i.id = ${id}`.pipe(
        Effect.orDie,
      )
    if (row === undefined) return yield* Cloud.NotFound.make({ resource: "invitation", id })
    return row
  })
  const getMember = Effect.fn("Accounts.member")(function* (organizationId: string, id: string) {
    const [row] =
      yield* sql<MemberRow>`SELECT m.*, u.name, u.email, u.image FROM member m JOIN "user" u ON u.id = m."userId" WHERE m.id = ${id} AND m."organizationId" = ${organizationId}`.pipe(
        Effect.orDie,
      )
    if (row === undefined) return yield* Cloud.NotFound.make({ resource: "member", id })
    return row
  })
  return {
    auth,
    access,
    sql,
    repository,
    memberships,
    getOrganization,
    audit,
    getInvitation,
    getMember,
  }
})

export const OrganizationsLive = HttpApiBuilder.group(Cloud.CloudApi, "organizations", (handlers) =>
  Effect.gen(function* () {
    const { auth, access, sql, memberships, getOrganization, audit } = yield* services
    return handlers
      .handle("list", () => memberships)
      .handle("get", ({ params }) => getOrganization(params.organizationId))
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          yield* access.person
          const h = yield* headers
          const result = yield* authCall(() =>
            auth.api.createOrganization({ headers: h, body: payload }),
          )
          if (result === null)
            return yield* Cloud.Conflict.make({ message: "Organization was not created" })
          yield* audit(result.id, "organization.create", result.id)
          const caller = yield* Cloud.CurrentIdentity
          if (Predicate.isTagged(caller, "session")) {
            const [user] = yield* sql<{
              readonly email: string
            }>`SELECT email FROM "user" WHERE id = ${caller.userId}`.pipe(Effect.orDie)
            if (user !== undefined) {
              const billing = yield* BillingActor.get(result.id)
              yield* billing
                .InitializeAccount({ email: user.email, name: result.name })
                .pipe(
                  Effect.mapError(() =>
                    Cloud.Conflict.make({ message: "Billing initialization is pending" }),
                  ),
                )
            }
          }
          return yield* getOrganization(result.id)
        }),
      )
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* access.person
          yield* access.organization(params.organizationId, "admin")
          const h = yield* headers
          yield* audit(
            params.organizationId,
            "organization.update.requested",
            params.organizationId,
          )
          yield* authCall(() =>
            auth.api.updateOrganization({
              headers: h,
              body: { organizationId: params.organizationId, data: payload },
            }),
          )
          yield* audit(params.organizationId, "organization.update", params.organizationId)
          return (yield* getOrganization(params.organizationId)).organization
        }),
      )
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          yield* access.person
          const grant = yield* access.organization(params.organizationId, "admin")
          if (grant.role !== "owner")
            return yield* Cloud.Forbidden.make({
              message: "Only the owner may delete an organization",
            })
          const h = yield* headers
          const [project] =
            yield* sql`SELECT id FROM cloud_project WHERE organization_id = ${params.organizationId} LIMIT 1`.pipe(
              Effect.orDie,
            )
          if (project !== undefined)
            return yield* Cloud.Conflict.make({
              message: "Delete the organization's projects first",
            })
          yield* audit(
            params.organizationId,
            "organization.delete.requested",
            params.organizationId,
          )
          yield* authCall(() =>
            auth.api.deleteOrganization({
              headers: h,
              body: { organizationId: params.organizationId },
            }),
          )
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE apikey SET enabled = false WHERE "referenceId" = ${params.organizationId}`
                yield* sql`UPDATE cloud_api_key SET revoked_at = now() WHERE organization_id = ${params.organizationId}`
                yield* audit(params.organizationId, "organization.delete", params.organizationId)
              }),
            )
            .pipe(Effect.orDie)
        }),
      )
  }),
)

export const MembersLive = HttpApiBuilder.group(Cloud.CloudApi, "members", (handlers) =>
  Effect.gen(function* () {
    const { auth, access, sql, audit, getMember } = yield* services
    return handlers
      .handle("list", ({ params }) =>
        Effect.gen(function* () {
          yield* access.organization(params.organizationId)
          const rows =
            yield* sql<MemberRow>`SELECT m.*, u.name, u.email, u.image FROM member m JOIN "user" u ON u.id = m."userId" WHERE m."organizationId" = ${params.organizationId} ORDER BY m."createdAt"`.pipe(
              Effect.orDie,
            )
          return yield* Effect.forEach(rows, member)
        }),
      )
      .handle("updateRole", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* access.person
          const grant = yield* access.organization(params.organizationId, "admin")
          const current = yield* getMember(params.organizationId, params.memberId)
          if ((current.role === "owner" || payload.role === "owner") && grant.role !== "owner")
            return yield* Cloud.Forbidden.make({ message: "Only an owner may change ownership" })
          const h = yield* headers
          yield* audit(params.organizationId, "member.update.requested", params.memberId)
          yield* authCall(() =>
            auth.api.updateMemberRole({
              headers: h,
              body: {
                organizationId: params.organizationId,
                memberId: params.memberId,
                role: payload.role,
              },
            }),
          )
          yield* audit(params.organizationId, "member.update", params.memberId)
          return yield* member(yield* getMember(params.organizationId, params.memberId))
        }),
      )
      .handle("remove", ({ params }) =>
        Effect.gen(function* () {
          yield* access.person
          yield* access.organization(params.organizationId, "admin")
          yield* getMember(params.organizationId, params.memberId)
          const h = yield* headers
          yield* audit(params.organizationId, "member.remove.requested", params.memberId)
          yield* authCall(() =>
            auth.api.removeMember({
              headers: h,
              body: { organizationId: params.organizationId, memberIdOrEmail: params.memberId },
            }),
          )
          yield* audit(params.organizationId, "member.remove", params.memberId)
        }),
      )
  }),
)

export const InvitationsLive = HttpApiBuilder.group(Cloud.CloudApi, "invitations", (handlers) =>
  Effect.gen(function* () {
    const { auth, access, sql, audit, getInvitation, getOrganization } = yield* services
    const invitee = Effect.fn("Accounts.invitee")(function* (id: string) {
      const userId = yield* access.person
      const row = yield* getInvitation(id)
      const [user] = yield* sql<{
        email: string
      }>`SELECT email FROM "user" WHERE id = ${userId}`.pipe(Effect.orDie)
      if (user?.email.toLowerCase() !== row.email.toLowerCase())
        return yield* Cloud.Forbidden.make({ message: "Invitation belongs to another person" })
      return row
    })
    return handlers
      .handle("list", ({ params }) =>
        Effect.gen(function* () {
          yield* access.organization(params.organizationId)
          const rows =
            yield* sql<InvitationRow>`SELECT i.*, u.name AS "inviterName" FROM invitation i JOIN "user" u ON u.id = i."inviterId" WHERE i."organizationId" = ${params.organizationId} ORDER BY i."createdAt"`.pipe(
              Effect.orDie,
            )
          return yield* Effect.forEach(rows, invitation)
        }),
      )
      .handle("create", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* access.person
          yield* access.organization(params.organizationId, "admin")
          const h = yield* headers
          yield* audit(params.organizationId, "invitation.create.requested", payload.email)
          const result = yield* authCall(() =>
            auth.api.createInvitation({
              headers: h,
              body: { ...payload, organizationId: params.organizationId },
            }),
          )
          yield* audit(params.organizationId, "invitation.create", result.id)
          return yield* invitation(yield* getInvitation(result.id))
        }),
      )
      .handle("resend", ({ params }) =>
        Effect.gen(function* () {
          yield* access.person
          yield* access.organization(params.organizationId, "admin")
          const row = yield* getInvitation(params.invitationId)
          if (row.organizationId !== params.organizationId)
            return yield* Cloud.NotFound.make({ resource: "invitation", id: params.invitationId })
          const h = yield* headers
          yield* audit(params.organizationId, "invitation.resend.requested", row.id)
          const role = yield* Schema.decodeUnknownEffect(Cloud.InviteRole)(row.role).pipe(
            Effect.orDie,
          )
          yield* authCall(() =>
            auth.api.createInvitation({
              headers: h,
              body: { organizationId: row.organizationId, email: row.email, role, resend: true },
            }),
          )
          yield* audit(params.organizationId, "invitation.resend", row.id)
          return yield* invitation(yield* getInvitation(row.id))
        }),
      )
      .handle("cancel", ({ params }) =>
        Effect.gen(function* () {
          yield* access.person
          yield* access.organization(params.organizationId, "admin")
          const row = yield* getInvitation(params.invitationId)
          if (row.organizationId !== params.organizationId)
            return yield* Cloud.NotFound.make({ resource: "invitation", id: params.invitationId })
          const h = yield* headers
          yield* audit(row.organizationId, "invitation.cancel.requested", row.id)
          yield* authCall(() =>
            auth.api.cancelInvitation({ headers: h, body: { invitationId: row.id } }),
          )
          yield* audit(row.organizationId, "invitation.cancel", row.id)
        }),
      )
      .handle("preview", ({ params }) =>
        Effect.gen(function* () {
          const row = yield* invitee(params.invitationId)
          const [org] = yield* sql<
            OrganizationRow & { memberCount: number }
          >`SELECT o.*, (SELECT count(*)::int FROM member m WHERE m."organizationId" = o.id) AS "memberCount" FROM organization o WHERE o.id = ${row.organizationId}`.pipe(
            Effect.orDie,
          )
          if (org === undefined)
            return yield* Cloud.NotFound.make({ resource: "organization", id: row.organizationId })
          return yield* Schema.decodeEffect(Schema.toType(Cloud.InvitationPreview))({
            ...(yield* invitation(row)),
            inviterName: row.inviterName,
            organization: { ...(yield* organization(org)), memberCount: org.memberCount },
          }).pipe(Effect.orDie)
        }),
      )
      .handle("accept", ({ params }) =>
        Effect.gen(function* () {
          const row = yield* invitee(params.invitationId)
          const h = yield* headers
          yield* audit(row.organizationId, "invitation.accept.requested", row.id)
          yield* authCall(() =>
            auth.api.acceptInvitation({ headers: h, body: { invitationId: row.id } }),
          )
          yield* audit(row.organizationId, "invitation.accept", row.id)
          return yield* getOrganization(row.organizationId)
        }),
      )
      .handle("decline", ({ params }) =>
        Effect.gen(function* () {
          const row = yield* invitee(params.invitationId)
          const h = yield* headers
          yield* audit(row.organizationId, "invitation.decline.requested", row.id)
          yield* authCall(() =>
            auth.api.rejectInvitation({ headers: h, body: { invitationId: row.id } }),
          )
          yield* audit(row.organizationId, "invitation.decline", row.id)
        }),
      )
  }),
)

export const ApiKeysLive = HttpApiBuilder.group(Cloud.CloudApi, "apiKeys", (handlers) =>
  Effect.gen(function* () {
    const { auth, access, sql, audit } = yield* services
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT pg_advisory_xact_lock(499500503)`
          yield* sql`CREATE TABLE IF NOT EXISTS cloud_api_key (
    id text PRIMARY KEY, organization_id text NOT NULL, name text NOT NULL, prefix text NOT NULL,
    last_four text NOT NULL, permission text NOT NULL CHECK (permission IN ('read','write','admin')),
    project_id text, created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
    last_used_at timestamptz, expires_at timestamptz, revoked_at timestamptz
  )`
        }),
      )
      .pipe(Effect.orDie)
    return handlers
      .handle("list", ({ params, query }) =>
        Effect.gen(function* () {
          yield* access.organization(params.organizationId, "admin")
          const rows =
            query.projectId === undefined
              ? yield* sql<KeyRow>`SELECT k.*, a."lastRequest" AS last_used_at FROM cloud_api_key k LEFT JOIN apikey a ON a.id = k.id WHERE k.organization_id = ${params.organizationId} ORDER BY k.created_at`.pipe(
                  Effect.orDie,
                )
              : yield* sql<KeyRow>`SELECT k.*, a."lastRequest" AS last_used_at FROM cloud_api_key k LEFT JOIN apikey a ON a.id = k.id WHERE k.organization_id = ${params.organizationId} AND k.project_id = ${query.projectId} ORDER BY k.created_at`.pipe(
                  Effect.orDie,
                )
          return yield* Effect.forEach(rows, key)
        }),
      )
      .handle("create", ({ params, payload }) =>
        Effect.gen(function* () {
          const userId = yield* access.person
          yield* access.organization(params.organizationId, "admin")
          if (
            payload.projectId !== undefined &&
            (yield* access.project(payload.projectId)) !== params.organizationId
          )
            return yield* Cloud.Forbidden.make({
              message: "Project belongs to another organization",
            })
          const now = yield* Clock.currentTimeMillis
          const expiresIn =
            payload.expiresAt === undefined
              ? undefined
              : Math.floor((DateTime.toEpochMillis(payload.expiresAt) - now) / 1000)
          if (expiresIn !== undefined && expiresIn <= 0)
            return yield* Cloud.Conflict.make({ message: "Key expiry must be in the future" })
          yield* audit(params.organizationId, "api-key.create.requested", payload.name)
          const created = yield* authCall(() =>
            auth.api.createApiKey({
              body: {
                userId,
                organizationId: params.organizationId,
                name: payload.name,
                expiresIn,
                permissions: { cloud: [payload.permission] },
              },
            }),
          )
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO cloud_api_key (id, organization_id, name, prefix, last_four, permission, project_id, created_by, expires_at)
          VALUES (${created.id}, ${params.organizationId}, ${payload.name}, ${created.prefix ?? "akter_"}, ${created.key.slice(-4)}, ${payload.permission}, ${payload.projectId ?? null}, ${userId}, ${created.expiresAt ?? null})`
                yield* audit(params.organizationId, "api-key.create", created.id)
              }),
            )
            .pipe(Effect.orDie)
          const [row] =
            yield* sql<KeyRow>`SELECT * FROM cloud_api_key WHERE id = ${created.id}`.pipe(
              Effect.orDie,
            )
          if (row === undefined) return yield* Effect.die(new Error("Created API key is missing"))
          return { key: yield* key(row), secret: created.key }
        }),
      )
      .handle("revoke", ({ params }) =>
        Effect.gen(function* () {
          yield* access.organization(params.organizationId, "admin")
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const rows =
                  yield* sql`UPDATE cloud_api_key SET revoked_at = COALESCE(revoked_at, now()) WHERE id = ${params.keyId} AND organization_id = ${params.organizationId} RETURNING id`
                if (rows.length === 0)
                  return yield* Cloud.NotFound.make({ resource: "api-key", id: params.keyId })
                yield* sql`UPDATE apikey SET enabled = false WHERE id = ${params.keyId} AND "referenceId" = ${params.organizationId}`
                yield* audit(params.organizationId, "api-key.revoke", params.keyId)
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die))
        }),
      )
  }),
)

export const AccountServices = services
export const AccountLayers = Layer.mergeAll(
  OrganizationsLive,
  MembersLive,
  InvitationsLive,
  ApiKeysLive,
)
