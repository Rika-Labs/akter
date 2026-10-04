import { Function, Match } from "effect"
import type { Action } from "../shell/action.ts"
import {
  choiceFields,
  parseMemberRoleKey,
  parseNotificationKey,
  spendLimitKey,
  toggleFields,
} from "./keys.ts"
import type { SettingsPage, SettingsSection } from "./model.ts"

/** Whether any of the slices holds sample data; views disable what a sample slice would act on. */
export const isSample = (
  page: SettingsPage,
  ...sections: ReadonlyArray<SettingsSection>
): boolean => sections.some((section) => page.sampleSections.includes(section))

const of = (...sections: ReadonlyArray<SettingsSection>): ReadonlyArray<SettingsSection> => sections

/**
 * The slices an action acts on, which are the ones its control is rendered from. An action that is
 * not a settings change names none.
 */
export const actionSections = (action: Action): ReadonlyArray<SettingsSection> =>
  Match.value(action).pipe(
    Match.tags({
      SaveToggle: ({ key }) => {
        if (Object.keys(toggleFields).includes(key)) return of("preferences")
        return parseNotificationKey(key) === undefined ? of() : of("notifications")
      },
      SaveChoice: ({ key }) => {
        if (Object.keys(choiceFields).includes(key)) return of("preferences")
        if (key === spendLimitKey) return of("billing")
        return parseMemberRoleKey(key) === undefined ? of() : of("organization", "members")
      },
      UpdateProfile: () => of("profile"),
      SendPasswordReset: () => of("profile"),
      UpdateOrganization: () => of("organization"),
      InviteMember: () => of("organization", "invitations"),
      ResendInvitation: () => of("organization", "invitations"),
      AddDomain: () => of("domains"),
      VerifyDomain: () => of("domains"),
      AddRegion: () => of("regions"),
      ConnectIntegration: () => of("integrations"),
      StartCheckout: () => of("billing"),
      ChangePlan: () => of("billing"),
      OpenBillingPortal: () => of("billing"),
      SetVariable: () => of("environments"),
      CreateKey: () => of("keys"),
      RevokeKey: () => of("keys"),
      DeleteProject: () => of("project"),
    }),
    Match.orElse(() => of()),
  )

/**
 * Whether the page the action was started from shows sample data for what the action changes. The
 * shell asks before it runs `Mutate` and must then neither run it nor report it as saved.
 */
export const blockedBySample: {
  (page: SettingsPage, action: Action): boolean
  (action: Action): (page: SettingsPage) => boolean
} = Function.dual(2, (page: SettingsPage, action: Action): boolean =>
  isSample(page, ...actionSections(action)),
)
