import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

import { ReadErrors, SelfErrors, WriteErrors } from "../errors.ts"
import {
  ApiKey,
  CreateApiKey,
  CreatedApiKey,
  CreateInvitation,
  CreateOrganization,
  DeleteAccount,
  Invitation,
  InvitationPreview,
  Me,
  Member,
  NotificationSettings,
  Organization,
  OrganizationDeletion,
  OrganizationMembership,
  PersonalDataExport,
  PinActor,
  PinnedActor,
  Preferences,
  SetActiveOrganization,
  UpdateMemberRole,
  UpdateOrganization,
  UpdatePreferences,
  UpdateProfile,
  User,
} from "../identity.ts"
import {
  ApiKeyId,
  EnvironmentName,
  InvitationId,
  MemberId,
  OrganizationId,
  ProjectId,
} from "../primitives.ts"

const organizationParams = { organizationId: OrganizationId }

export class AccountGroup extends HttpApiGroup.make("account").add(
  HttpApiEndpoint.get("me", "/me", { success: Me, error: SelfErrors }),
  HttpApiEndpoint.get("exportData", "/me/export", {
    success: PersonalDataExport,
    error: SelfErrors,
  }),
  HttpApiEndpoint.delete("deleteAccount", "/me", {
    payload: DeleteAccount,
    error: WriteErrors,
  }),
  HttpApiEndpoint.patch("updateProfile", "/me", {
    payload: UpdateProfile,
    success: User,
    error: SelfErrors,
  }),
  HttpApiEndpoint.put("setActiveOrganization", "/me/active-organization", {
    payload: SetActiveOrganization,
    success: OrganizationMembership,
    error: WriteErrors,
  }),
  HttpApiEndpoint.get("getPreferences", "/me/preferences", {
    success: Preferences,
    error: SelfErrors,
  }),
  HttpApiEndpoint.patch("updatePreferences", "/me/preferences", {
    payload: UpdatePreferences,
    success: Preferences,
    error: SelfErrors,
  }),
  HttpApiEndpoint.get("getNotifications", "/me/notifications", {
    success: NotificationSettings,
    error: SelfErrors,
  }),
  HttpApiEndpoint.put("setNotifications", "/me/notifications", {
    payload: NotificationSettings,
    success: NotificationSettings,
    error: SelfErrors,
  }),
  HttpApiEndpoint.get("listPinnedActors", "/me/pinned-actors", {
    query: { projectId: ProjectId, environment: EnvironmentName },
    success: Schema.Array(PinnedActor),
    error: ReadErrors,
  }),
  HttpApiEndpoint.post("pinActor", "/me/pinned-actors", {
    payload: PinActor,
    success: PinnedActor,
    error: WriteErrors,
  }),
  HttpApiEndpoint.delete("unpinActor", "/me/pinned-actors", {
    query: { projectId: ProjectId, environment: EnvironmentName, address: Schema.String },
    error: WriteErrors,
  }),
) {}

export class OrganizationsGroup extends HttpApiGroup.make("organizations").add(
  HttpApiEndpoint.get("list", "/organizations", {
    success: Schema.Array(OrganizationMembership),
    error: SelfErrors,
  }),
  HttpApiEndpoint.post("create", "/organizations", {
    payload: CreateOrganization,
    success: OrganizationMembership,
    error: WriteErrors,
  }),
  HttpApiEndpoint.get("get", "/organizations/:organizationId", {
    params: organizationParams,
    success: OrganizationMembership,
    error: ReadErrors,
  }),
  HttpApiEndpoint.patch("update", "/organizations/:organizationId", {
    params: organizationParams,
    payload: UpdateOrganization,
    success: Organization,
    error: WriteErrors,
  }),
  HttpApiEndpoint.delete("delete", "/organizations/:organizationId", {
    params: organizationParams,
    error: WriteErrors,
  }),
  HttpApiEndpoint.get("getDeletion", "/organizations/:organizationId/deletion", {
    params: organizationParams,
    success: OrganizationDeletion,
    error: ReadErrors,
  }),
) {}

export class MembersGroup extends HttpApiGroup.make("members").add(
  HttpApiEndpoint.get("list", "/organizations/:organizationId/members", {
    params: organizationParams,
    success: Schema.Array(Member),
    error: ReadErrors,
  }),
  HttpApiEndpoint.patch("updateRole", "/organizations/:organizationId/members/:memberId", {
    params: { ...organizationParams, memberId: MemberId },
    payload: UpdateMemberRole,
    success: Member,
    error: WriteErrors,
  }),
  HttpApiEndpoint.delete("remove", "/organizations/:organizationId/members/:memberId", {
    params: { ...organizationParams, memberId: MemberId },
    error: WriteErrors,
  }),
) {}

export class InvitationsGroup extends HttpApiGroup.make("invitations").add(
  HttpApiEndpoint.get("list", "/organizations/:organizationId/invitations", {
    params: organizationParams,
    success: Schema.Array(Invitation),
    error: ReadErrors,
  }),
  HttpApiEndpoint.post("create", "/organizations/:organizationId/invitations", {
    params: organizationParams,
    payload: CreateInvitation,
    success: Invitation,
    error: WriteErrors,
  }),
  HttpApiEndpoint.post(
    "resend",
    "/organizations/:organizationId/invitations/:invitationId/resend",
    {
      params: { ...organizationParams, invitationId: InvitationId },
      success: Invitation,
      error: WriteErrors,
    },
  ),
  HttpApiEndpoint.delete("cancel", "/organizations/:organizationId/invitations/:invitationId", {
    params: { ...organizationParams, invitationId: InvitationId },
    error: WriteErrors,
  }),
  HttpApiEndpoint.get("preview", "/invitations/:invitationId", {
    params: { invitationId: InvitationId },
    success: InvitationPreview,
    error: ReadErrors,
  }),
  HttpApiEndpoint.post("accept", "/invitations/:invitationId/accept", {
    params: { invitationId: InvitationId },
    success: OrganizationMembership,
    error: WriteErrors,
  }),
  HttpApiEndpoint.post("decline", "/invitations/:invitationId/decline", {
    params: { invitationId: InvitationId },
    error: WriteErrors,
  }),
) {}

export class ApiKeysGroup extends HttpApiGroup.make("apiKeys").add(
  HttpApiEndpoint.get("list", "/organizations/:organizationId/api-keys", {
    params: organizationParams,
    query: { projectId: Schema.optional(ProjectId) },
    success: Schema.Array(ApiKey),
    error: ReadErrors,
  }),
  HttpApiEndpoint.post("create", "/organizations/:organizationId/api-keys", {
    params: organizationParams,
    payload: CreateApiKey,
    success: CreatedApiKey,
    error: WriteErrors,
  }),
  HttpApiEndpoint.delete("revoke", "/organizations/:organizationId/api-keys/:keyId", {
    params: { ...organizationParams, keyId: ApiKeyId },
    error: WriteErrors,
  }),
) {}
