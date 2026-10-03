import { Schema } from "effect"

import {
  ActorReference,
  ApiKeyId,
  Email,
  EnvironmentName,
  InvitationId,
  InviteRole,
  MemberId,
  Name,
  NonNegativeInt,
  OrganizationId,
  ProjectId,
  Role,
  Slug,
  Timestamp,
  UserId,
} from "./primitives.ts"

export const PlanId = Schema.Literals(["free", "pro", "enterprise"])
export type PlanId = typeof PlanId.Type

export const User = Schema.Struct({
  id: UserId,
  name: Schema.String,
  email: Email,
  emailVerified: Schema.Boolean,
  image: Schema.NullOr(Schema.String),
})
export type User = typeof User.Type

export const Organization = Schema.Struct({
  id: OrganizationId,
  name: Schema.String,
  slug: Slug,
  plan: PlanId,
  createdAt: Timestamp,
})
export type Organization = typeof Organization.Type

export const OrganizationMembership = Schema.Struct({
  organization: Organization,
  role: Role,
})
export type OrganizationMembership = typeof OrganizationMembership.Type

/**
 * The caller as the app shell needs it. `user` is null when an API key
 * called: a key is an organization's actor, not a person.
 */
export const Me = Schema.Struct({
  user: Schema.NullOr(User),
  identityKind: Schema.Literals(["session", "api-key"]),
  activeOrganizationId: Schema.NullOr(OrganizationId),
  organizations: Schema.Array(OrganizationMembership),
})
export type Me = typeof Me.Type

export const UpdateProfile = Schema.Struct({
  name: Schema.optional(Name),
  image: Schema.optional(Schema.NullOr(Schema.String)),
})
export type UpdateProfile = typeof UpdateProfile.Type

export const SetActiveOrganization = Schema.Struct({ organizationId: OrganizationId })
export type SetActiveOrganization = typeof SetActiveOrganization.Type

export const CreateOrganization = Schema.Struct({ name: Name, slug: Slug })
export type CreateOrganization = typeof CreateOrganization.Type

export const UpdateOrganization = Schema.Struct({
  name: Schema.optional(Name),
  slug: Schema.optional(Slug),
})
export type UpdateOrganization = typeof UpdateOrganization.Type

export const MemberUser = Schema.Struct({
  id: UserId,
  name: Schema.String,
  email: Email,
  image: Schema.NullOr(Schema.String),
})
export type MemberUser = typeof MemberUser.Type

export const Member = Schema.Struct({
  id: MemberId,
  user: MemberUser,
  role: Role,
  createdAt: Timestamp,
  lastActiveAt: Schema.NullOr(Timestamp),
})
export type Member = typeof Member.Type

export const UpdateMemberRole = Schema.Struct({ role: Role })
export type UpdateMemberRole = typeof UpdateMemberRole.Type

export const InvitationStatus = Schema.Literals([
  "pending",
  "accepted",
  "declined",
  "canceled",
  "expired",
])
export type InvitationStatus = typeof InvitationStatus.Type

export const Invitation = Schema.Struct({
  id: InvitationId,
  organizationId: OrganizationId,
  email: Email,
  role: InviteRole,
  status: InvitationStatus,
  invitedBy: Schema.Struct({ id: UserId, name: Schema.String }),
  createdAt: Timestamp,
  expiresAt: Timestamp,
})
export type Invitation = typeof Invitation.Type

export const CreateInvitation = Schema.Struct({ email: Email, role: InviteRole })
export type CreateInvitation = typeof CreateInvitation.Type

/** What the accept-invitation screen shows the invitee. */
export const InvitationPreview = Schema.Struct({
  id: InvitationId,
  email: Email,
  role: InviteRole,
  status: InvitationStatus,
  expiresAt: Timestamp,
  inviterName: Schema.String,
  organization: Schema.Struct({
    id: OrganizationId,
    name: Schema.String,
    slug: Slug,
    plan: PlanId,
    memberCount: NonNegativeInt,
  }),
})
export type InvitationPreview = typeof InvitationPreview.Type

export const ApiKeyPermission = Schema.Literals(["read", "write", "admin"])
export type ApiKeyPermission = typeof ApiKeyPermission.Type

/** An organization-owned key. Only a prefix and the last four characters are ever readable. */
export const ApiKey = Schema.Struct({
  id: ApiKeyId,
  organizationId: OrganizationId,
  name: Schema.String,
  prefix: Schema.String,
  lastFour: Schema.String,
  permission: ApiKeyPermission,
  projectId: Schema.NullOr(ProjectId),
  createdAt: Timestamp,
  createdBy: ActorReference,
  lastUsedAt: Schema.NullOr(Timestamp),
  expiresAt: Schema.NullOr(Timestamp),
  revokedAt: Schema.NullOr(Timestamp),
})
export type ApiKey = typeof ApiKey.Type

export const CreateApiKey = Schema.Struct({
  name: Name,
  permission: ApiKeyPermission,
  projectId: Schema.optional(ProjectId),
  expiresAt: Schema.optional(Timestamp),
})
export type CreateApiKey = typeof CreateApiKey.Type

/** The one response that carries a key's secret; it is never readable again. */
export const CreatedApiKey = Schema.Struct({
  key: ApiKey,
  secret: Schema.String,
})
export type CreatedApiKey = typeof CreatedApiKey.Type

export const Theme = Schema.Literals(["light", "dark", "system"])
export type Theme = typeof Theme.Type

export const Preferences = Schema.Struct({
  defaultEnvironment: EnvironmentName,
  openActorLinksInNewTab: Schema.Boolean,
  timeZone: Schema.String,
  pauseLiveTailOnScroll: Schema.Boolean,
  showReplayedCommands: Schema.Boolean,
  theme: Theme,
})
export type Preferences = typeof Preferences.Type

export const UpdatePreferences = Schema.Struct({
  defaultEnvironment: Schema.optional(EnvironmentName),
  openActorLinksInNewTab: Schema.optional(Schema.Boolean),
  timeZone: Schema.optional(Schema.String),
  pauseLiveTailOnScroll: Schema.optional(Schema.Boolean),
  showReplayedCommands: Schema.optional(Schema.Boolean),
  theme: Schema.optional(Theme),
})
export type UpdatePreferences = typeof UpdatePreferences.Type

export const NotificationEvent = Schema.Literals([
  "deploy_failed",
  "dead_letter",
  "spend_threshold",
])
export type NotificationEvent = typeof NotificationEvent.Type

export const NotificationPreference = Schema.Struct({
  event: NotificationEvent,
  email: Schema.Boolean,
  slack: Schema.Boolean,
})
export type NotificationPreference = typeof NotificationPreference.Type

export const NotificationSettings = Schema.Struct({
  preferences: Schema.Array(NotificationPreference),
})
export type NotificationSettings = typeof NotificationSettings.Type

/** A pinned actor with the live status the sidebar shows; `unknown` when no deployment is running. */
export const PinnedActor = Schema.Struct({
  projectId: ProjectId,
  environment: EnvironmentName,
  address: Schema.String,
  status: Schema.Literals(["awake", "idle", "unknown"]),
  lastActivityAt: Schema.NullOr(Timestamp),
})
export type PinnedActor = typeof PinnedActor.Type

export const PinActor = Schema.Struct({
  projectId: ProjectId,
  environment: EnvironmentName,
  address: Schema.String,
})
export type PinActor = typeof PinActor.Type
