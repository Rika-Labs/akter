import type { NotificationEvent, PlanId, Preferences } from "@akter/cloud-api"
import {
  billedPlan,
  type Billing,
  type PaidPlan,
  type PlanOffer,
  type Plans,
  type SettingsPage,
} from "./model.ts"

/**
 * The names the settings views give their switches and selects in the shell's `toggles` and
 * `choices`, and how each one maps to the control plane. The views, `settingsSeed` and `saveSetting`
 * all read them from here so a rename cannot leave one of them behind.
 */

/** Switch keys that are preferences, and the preference each one writes. */
export const toggleFields = {
  openInNewTab: "openActorLinksInNewTab",
  pauseOnScroll: "pauseLiveTailOnScroll",
  showReplayed: "showReplayedCommands",
} as const satisfies Readonly<Record<string, keyof Preferences>>

/** Select keys that are preferences, and the preference each one writes. */
export const choiceFields = {
  defaultEnvironment: "defaultEnvironment",
  timeZone: "timeZone",
} as const satisfies Readonly<Record<string, keyof Preferences>>

export type NotificationChannel = "email" | "slack"

export const notificationKey = (input: {
  readonly channel: NotificationChannel
  readonly event: NotificationEvent
}): string => `notify.${input.channel}.${input.event}`

const notificationPattern = /^notify\.(email|slack)\.([a-z_]+)$/u

/** The channel and event a notification switch key names, or undefined for any other key. */
export const parseNotificationKey = (
  key: string,
): { readonly channel: NotificationChannel; readonly event: string } | undefined => {
  const match = notificationPattern.exec(key)
  const channel = match?.[1]
  const event = match?.[2]
  if ((channel !== "email" && channel !== "slack") || event === undefined) return undefined
  return { channel, event }
}

const memberRolePrefix = "role-"

/** The select key of one member's role; it carries the member's id, which is what a change needs. */
export const memberRoleKey = (memberId: string): string => `${memberRolePrefix}${memberId}`

/** The member id a role select key names, or undefined for any other key. */
export const parseMemberRoleKey = (key: string): string | undefined =>
  key.startsWith(memberRolePrefix) ? key.slice(memberRolePrefix.length) : undefined

/** The select key of the paid plan an organization would move to; it is never saved by itself. */
export const planChoiceKey = "plan"

/**
 * Whether the organization pays for a plan, so a change goes through the plan endpoint rather than
 * a new Checkout. The control plane prices billing at the subscribed plan, and only plans with a
 * base price are sold through Checkout, so a zero price means no paid subscription; an
 * organization without a billing account has no subscription at all.
 */
export const hasPaidPlan = (billing: Billing): boolean =>
  (billedPlan(billing)?.basePriceCents ?? 0) > 0

/**
 * The catalog's plans an organization subscribed to `subscribed` can buy or move to, cheapest
 * first; `subscribed` is null for an organization without a billing account. Without a catalog
 * there is nothing to offer, since the console knows no plan of its own.
 */
export const planChoices = (input: {
  readonly subscribed: PlanId | null
  readonly plans: Plans | null
}): ReadonlyArray<{ readonly plan: PaidPlan; readonly offer: PlanOffer }> =>
  (input.plans?.plans ?? []).flatMap((offer) =>
    offer.checkout === null || offer.id === input.subscribed
      ? []
      : [{ plan: offer.checkout, offer }],
  )

/** The select key of the monthly spend limit; its value is whole cents or `none`. */
export const spendLimitKey = "spendLimit"

export const spendLimitValue = (limitCents: number | null): string =>
  limitCents === null ? "none" : String(limitCents)

/** Whole cents, `null` for no limit, or undefined when the value is neither. */
export const parseSpendLimit = (value: string): number | null | undefined => {
  if (value === "none") return null
  if (!/^\d+$/u.test(value)) return undefined
  const cents = Number(value)
  return Number.isSafeInteger(cents) ? cents : undefined
}

export interface SettingsSeed {
  readonly toggles: Record<string, boolean>
  readonly choices: Record<string, string>
}

/**
 * The `toggles` and `choices` a settings page starts with, read from what the control plane says.
 * The shell merges them in when the page loads so a switch flips from its real state and not from
 * unset.
 */
export const settingsSeed = (page: SettingsPage): SettingsSeed => {
  const toggles: Record<string, boolean> = {}
  const choices: Record<string, string> = {}
  const { preferences } = page
  if (preferences !== null) {
    for (const [key, field] of Object.entries(toggleFields)) toggles[key] = preferences[field]
    for (const [key, field] of Object.entries(choiceFields)) choices[key] = preferences[field]
  }
  for (const entry of page.notifications) {
    toggles[notificationKey({ channel: "email", event: entry.event })] = entry.email
    toggles[notificationKey({ channel: "slack", event: entry.event })] = entry.slack
  }
  if (page.billing !== null)
    choices[spendLimitKey] = spendLimitValue(page.billing.spendLimit.limitCents)
  for (const member of page.members) choices[memberRoleKey(member.id)] = member.role
  return { toggles, choices }
}
