import { Option, Predicate, Schema as S } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import { blockedBySample } from "../settings/sample.ts"
import type { PageData } from "./page.ts"

/**
 * A change the console makes through the cloud API, named for what it does. Each one is run by the
 * `Mutate` Command and answers with a Message the shell turns into a toast, a reload or a redirect.
 */
export const Action = defineTaggedUnion({
  SaveToggle: { key: S.String, enabled: S.Boolean },
  SaveChoice: { key: S.String, value: S.String },
  UpdateProfile: { name: S.String },
  SendPasswordReset: { email: S.String },
  UpdateOrganization: { name: S.String, slug: S.String },
  InviteMember: { email: S.String, role: S.String },
  ResendInvitation: { id: S.String },
  AddDomain: { hostname: S.String, environment: S.String },
  VerifyDomain: { id: S.String },
  AddRegion: { region: S.String },
  ConnectIntegration: { kind: S.String },
  StartCheckout: { plan: S.Literals(["pro", "enterprise"]) },
  OpenBillingPortal: {},
  SetVariable: { environment: S.String, name: S.String, value: S.String },
  CreateKey: { name: S.String, permission: S.String, projectScoped: S.Boolean },
  RevokeKey: { id: S.String, name: S.String },
  DeleteProject: { slug: S.String },
  RetryDeadLetters: { ids: S.Array(S.String) },
  DiscardDeadLetter: { id: S.String },
  RollBack: { id: S.String, commit: S.String },
  Redeploy: { id: S.String, commit: S.String },
})
export type Action = typeof Action.Type

/** Sample provenance blocks admission even when an event bypasses a disabled control. */
export const canMutate = (
  input: Readonly<{
    page: Option.Option<PageData>
    sample: boolean
    loading: boolean
    action: Action
  }>,
): boolean =>
  !input.loading &&
  Option.match(input.page, {
    onNone: () => !input.sample,
    onSome: (page) =>
      Predicate.isTagged(page, "SettingsPage")
        ? !blockedBySample(page, input.action)
        : !input.sample,
  })
