import { Dialog } from "../shell/model.ts"
import {
  button,
  dataTable,
  input,
  select,
  settingsGroup,
  settingsPage,
  settingsRow,
  status,
  styleAttributes,
} from "@akter/ui"
import { barChart, meter } from "@akter/ui/charts"
import { formatCompact, formatCurrency, formatInteger } from "@akter/ui/geometry"
import { Match } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
  ChangedField,
  ChoseSetting,
  type Message,
  OpenedDialog,
  SubmittedForm,
} from "../shell/message.ts"
import type { Screen, ScreenInput } from "../shell/screen.ts"
import {
  dollars,
  formatCents,
  formatDate,
  formatDay,
  formatExpiry,
  formatGigabytes,
  formatInstant,
  formatMonth,
  formatPeriod,
  titleCase,
} from "./format.ts"
import { capNotice, isUnbound, spendLimitReached } from "../quota/model.ts"
import { capNoticeView, capStateView } from "../quota/view.ts"
import {
  memberRoleKey,
  parseSpendLimit,
  hasPaidPlan,
  planChoiceKey,
  planChoices,
  spendLimitKey,
  spendLimitValue,
} from "./keys.ts"
import {
  billedPlan,
  type BillingPlan,
  type PaymentStatus,
  type PlanOffer,
  type Plans,
  type SettingsPage,
  type Usage,
  type UsageMeter,
} from "./model.ts"
import { isSample } from "./sample.ts"
import { settingsStyles as styles } from "./styles.ts"

type H = HtmlBuilder<Message>

const screen = (
  h: H,
  title: string,
  children: ReadonlyArray<Html>,
  description?: string,
): Screen => ({
  title,
  crumbs: [{ label: "Settings" }, { label: title }],
  body: settingsPage(h, { title, description, children }),
})

const assignableRoles = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
  { value: "viewer", label: "Viewer" },
]

/** Organization › General: its name, URL, and deleting a project. */
export const organizationScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen => {
  const { organization, project } = page
  if (organization === null) return screen(h, "Organization", [])
  const organizationSample = isSample(page, "organization")
  return screen(h, "Organization", [
    settingsGroup(h, {
      rows: [
        settingsRow(h, {
          label: "Name",
          control: input(h, {
            name: "org-name",
            label: "Organization name",
            value: model.fields["org-name"] ?? organization.name,
            size: "sm",
            disabled: organizationSample,
            onInput: (value) => ChangedField({ name: "org-name", value }),
          }),
        }),
        settingsRow(h, {
          label: "URL",
          description: `akter.cloud/${model.fields["org-slug"] ?? organization.slug}`,
          control: input(h, {
            name: "org-slug",
            label: "Organization URL",
            value: model.fields["org-slug"] ?? organization.slug,
            size: "sm",
            mono: true,
            disabled: organizationSample,
            onInput: (value) => ChangedField({ name: "org-slug", value }),
          }),
        }),
      ],
    }),
    h.div(
      [],
      [
        button(h, {
          label: "Save",
          variant: "primary",
          disabled: organizationSample,
          onClick: SubmittedForm({ form: "organization" }),
        }),
      ],
    ),
    ...(project === null
      ? []
      : [
          settingsGroup(h, {
            title: "Danger zone",
            rows: [
              settingsRow(h, {
                label: `Delete ${project.name}`,
                tone: "danger",
                description: "Stops every runner and erases its database after a 7-day hold.",
                control: button(h, {
                  label: "Delete project",
                  size: "sm",
                  disabled: isSample(page, "project"),
                  onClick: OpenedDialog({
                    dialog: Dialog.DeleteProject({ project: project.slug }),
                  }),
                }),
              }),
            ],
          }),
        ]),
  ])
}

/** Organization › Members: who has access, in which role, and pending invitations. */
export const membersScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen => {
  const canManage = page.organization?.role === "owner" || page.organization?.role === "admin"
  const inviteDisabled = isSample(page, "organization", "invitations")
  const rolesDisabled = isSample(page, "organization", "members")
  const resendDisabled = isSample(page, "organization", "invitations")
  return screen(h, "Members", [
    ...(canManage
      ? [
          h.form(
            [
              h.OnSubmit(SubmittedForm({ form: "invite-member" })),
              h.AriaLabel("Invite a member"),
              ...styleAttributes(h, styles.inline),
            ],
            [
              h.span(
                [...styleAttributes(h, styles.grow)],
                [
                  input(h, {
                    name: "invite-email",
                    label: "Email to invite",
                    type: "email",
                    value: model.fields["invite-email"] ?? "",
                    placeholder: "Invite by email",
                    required: true,
                    disabled: inviteDisabled,
                    onInput: (value) => ChangedField({ name: "invite-email", value }),
                  }),
                ],
              ),
              select(h, {
                name: "invite-role",
                label: "Role",
                value: model.choices["inviteRole"] ?? "member",
                size: "md",
                disabled: inviteDisabled,
                options: assignableRoles,
                onChange: (value) => ChoseSetting({ key: "inviteRole", value }),
              }),
              button(h, {
                label: "Invite",
                variant: "primary",
                type: "submit",
                disabled: inviteDisabled,
              }),
            ],
          ),
        ]
      : []),
    settingsGroup(h, {
      rows: [
        ...page.members.map((member) =>
          settingsRow(h, {
            label: member.name,
            description: member.email,
            control:
              !canManage || member.role === "owner"
                ? h.span([...styleAttributes(h, styles.muted)], [titleCase(member.role)])
                : select(h, {
                    name: memberRoleKey(member.id),
                    label: `Role for ${member.name}`,
                    value: model.choices[memberRoleKey(member.id)] ?? member.role,
                    disabled: rolesDisabled,
                    options: assignableRoles,
                    onChange: (value) => ChoseSetting({ key: memberRoleKey(member.id), value }),
                  }),
          }),
        ),
        ...page.invitations.map((invitation) =>
          settingsRow(h, {
            label: invitation.email,
            description: `Invited as ${invitation.role} by ${invitation.invitedBy} · ${formatDate(invitation.createdAt)}`,
            control: canManage
              ? button(h, {
                  label: "Resend",
                  variant: "ghost",
                  size: "sm",
                  disabled: resendDisabled,
                  onClick: SubmittedForm({ form: `resend-invite:${invitation.id}` }),
                  attributes: [h.AriaLabel(`Resend invitation to ${invitation.email}`)],
                })
              : status(h, { tone: "idle", label: "Pending" }),
          }),
        ),
      ],
    }),
    settingsGroup(h, {
      title: "Roles",
      rows: [
        settingsRow(h, { label: "Owner", description: "Billing, members and everything else" }),
        settingsRow(h, { label: "Admin", description: "Deploys, environment and members" }),
        settingsRow(h, { label: "Member", description: "Deploy, inspect actors and retry jobs" }),
        settingsRow(h, { label: "Viewer", description: "Read-only" }),
      ],
    }),
  ])
}

const spendLimitOptions = (limitCents: number | null) => {
  const cents = [25_000, 50_000, 100_000]
  const all = limitCents === null || cents.includes(limitCents) ? cents : [...cents, limitCents]
  return [
    ...all
      .toSorted((a, b) => a - b)
      .map((value) => ({
        value: spendLimitValue(value),
        label: formatCurrency(dollars(value)).replace(/\.00$/u, ""),
      })),
    { value: spendLimitValue(null), label: "No limit" },
  ]
}

const paymentProblems: Readonly<Partial<Record<PaymentStatus, string>>> = {
  past_due: "The last payment failed",
  unpaid: "The subscription is unpaid",
  incomplete: "The first payment hasn’t gone through",
  canceled: "The subscription was canceled",
}

const planPrice = (plan: BillingPlan): string =>
  plan.basePriceCents === 0
    ? "No monthly charge"
    : `${formatCurrency(dollars(plan.basePriceCents))} a month plus usage${plan.provisional ? " (provisional price)" : ""}`

/** How the plan reads: its price, when it renews, and why paid limits are withheld if they are. */
const planDescription = (plan: BillingPlan): string => {
  const problem = plan.paymentStatus === null ? undefined : paymentProblems[plan.paymentStatus]
  const withheld =
    plan.subscribed !== plan.id
      ? `${problem ?? "Payment is pending"}, so ${plan.name} limits apply until ${titleCase(plan.subscribed)} is paid for`
      : problem
  return [
    planPrice(plan),
    ...(plan.renewsAt === null ? [] : [`renews ${formatDate(plan.renewsAt)}`]),
    ...(withheld === undefined ? [] : [withheld]),
  ].join(" · ")
}

/**
 * Billing or Usage for an organization whose stored plan the pricing configuration doesn't define.
 * The control plane can't price it and the edge refuses its work, which retrying won't change, so
 * the page says so calmly instead of failing as if billing were down.
 */
const unknownPlanScreen = (h: H, title: string): Screen =>
  screen(h, title, [
    settingsGroup(h, {
      title: "Plan",
      rows: [
        settingsRow(h, {
          label: "Plan not recognised",
          description: "This organization’s plan isn’t recognised. Contact support.",
        }),
      ],
    }),
  ])

/**
 * What a plan includes, as the catalog states it: its commands and storage, and for each whether it
 * is a hard cap or billed beyond the allowance.
 */
const allowances = (offer: PlanOffer, readCommandWeight: number): string => {
  const commands = `${formatCompact(offer.commandCap ?? offer.includedCommands)} commands a month (a read counts as ${String(readCommandWeight)} of a command)${offer.commandCap === null ? `, then ${formatCents(offer.commandCentsPerMillion)} per million` : ""}`
  const storage = `${formatGigabytes(offer.storageGb)} of storage${offer.storageCap ? "" : `, then ${formatCents(offer.storageCentsPerGbMonth)} per GB-month`}`
  const capped = [
    ...(offer.commandCap === null ? [] : ["commands"]),
    ...(offer.storageCap ? ["storage"] : []),
  ]
  const caps =
    capped.length === 2
      ? ["Both are hard caps: at either one, new commands are refused while reads keep working."]
      : capped.map(
          (name) =>
            `The ${name} allowance is a hard cap: at it, new commands are refused while reads keep working.`,
        )
  return [`${commands} and ${storage}.`, ...caps].join(" ")
}

/** A monthly price as the comparison lists it: whole dollars unless there are cents, `$0` for none. */
const shortPrice = (cents: number): string =>
  `${formatCurrency(dollars(cents)).replace(/\.00$/u, "")}${cents === 0 ? "" : " / mo"}`

/** A comparison cell: the allowance, and underneath it, quietly, what happens beyond it. */
const allowanceCell = (h: H, amount: string, beyond: string): Html =>
  h.span([], [amount, h.span([...styleAttributes(h, styles.detail)], [beyond])])

/**
 * Every plan in the catalog side by side, so a choice in the picker can be compared first. Cells
 * wrap rather than truncate, and provisional prices are named once in the footnote.
 */
const planComparison = (
  h: H,
  input: { readonly plans: Plans; readonly current: string | null },
) => {
  const provisional = input.plans.plans.flatMap((offer) => (offer.provisional ? [offer.name] : []))
  return settingsGroup(h, {
    title: "Plans",
    footnote:
      provisional.length === 0
        ? undefined
        : `${new Intl.ListFormat("en-US").format(provisional)} prices are provisional: they aren’t final and may change before they are published.`,
    rows: [
      dataTable(h, {
        label: "Plan comparison",
        bare: true,
        empty: "No plans are offered.",
        columns: [
          { key: "plan", label: "Plan", width: "minmax(0, 1fr)", wrap: true },
          { key: "price", label: "Price", width: "minmax(0, 0.8fr)", wrap: true },
          { key: "commands", label: "Commands a month", width: "minmax(0, 1.3fr)", wrap: true },
          { key: "storage", label: "Storage", width: "minmax(0, 1.3fr)", wrap: true },
          { key: "connections", label: "Connections", width: "6.5rem", align: "end" },
        ],
        rows: input.plans.plans.map((offer) => ({
          key: offer.id,
          cells: [
            offer.id === input.current ? `${offer.name} (current)` : offer.name,
            shortPrice(offer.basePriceCents),
            offer.commandCap === null
              ? allowanceCell(
                  h,
                  formatCompact(offer.includedCommands),
                  `then ${formatCents(offer.commandCentsPerMillion)} per million`,
                )
              : allowanceCell(h, formatCompact(offer.commandCap), "hard cap"),
            offer.storageCap
              ? allowanceCell(h, formatGigabytes(offer.storageGb), "hard cap")
              : allowanceCell(
                  h,
                  formatGigabytes(offer.storageGb),
                  `then ${formatCents(offer.storageCentsPerGbMonth)} per GB-month`,
                ),
            formatCompact(offer.connections),
          ],
        })),
      }),
    ],
  })
}

/**
 * Organization › Billing: the plan and its change, the catalog to compare plans in, payment method,
 * spend limit and invoices. An organization without a billing account is refused every new command
 * by the edge, so it reads as not set up, never as Free, and shows no price or allowance of its own.
 */
export const billingScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen => {
  const { billing, plans, usage } = page
  if (billing === null)
    return page.unknownPlan ? unknownPlanScreen(h, "Billing") : screen(h, "Billing", [])
  const billingSample = isSample(page, "billing")
  const free = !hasPaidPlan(billing)
  const plan = billedPlan(billing)
  const notice =
    plan === undefined || usage === null
      ? undefined
      : capNotice({ caps: billing.caps, period: usage.period })
  const choices = planChoices({ subscribed: plan?.subscribed ?? null, plans })
  const current =
    plan === undefined ? undefined : plans?.plans.find((offer) => offer.id === plan.id)
  const limit = parseSpendLimit(
    model.choices[spendLimitKey] ?? spendLimitValue(billing.spendLimit.limitCents),
  )
  return screen(h, "Billing", [
    ...(notice === undefined ? [] : [capStateView(h, notice)]),
    settingsGroup(h, {
      title: "Plan",
      rows: [
        plan === undefined
          ? settingsRow(h, {
              label: "Billing isn’t set up",
              description: `This organization has no billing account, so new commands are refused.${choices.length === 0 ? "" : " Choosing a plan sets one up."}`,
            })
          : settingsRow(h, { label: plan.name, description: planDescription(plan) }),
        ...(current === undefined || plans === null
          ? []
          : [
              settingsRow(h, {
                label: "Included",
                description: allowances(current, plans.readCommandWeight),
              }),
            ]),
        ...(choices.length === 0
          ? []
          : [
              settingsRow(h, {
                label: plan === undefined ? "Choose a plan" : free ? "Upgrade" : "Change plan",
                description: free
                  ? "Checkout opens on Stripe, which shows the price before you pay."
                  : "Invoiced right away; the new plan applies once the payment goes through.",
                control: h.span(
                  [...styleAttributes(h, styles.inline)],
                  [
                    select(h, {
                      name: planChoiceKey,
                      label: free ? "Plan to upgrade to" : "Plan to change to",
                      value: model.choices[planChoiceKey] ?? choices[0]?.plan ?? "",
                      size: "sm",
                      disabled: billingSample,
                      options: choices.map(({ plan, offer }) => ({
                        value: plan,
                        label: `${offer.name} · ${shortPrice(offer.basePriceCents)}${offer.provisional ? " (provisional)" : ""}`,
                      })),
                      onChange: (value) => ChoseSetting({ key: planChoiceKey, value }),
                    }),
                    button(h, {
                      label: free ? "Continue to checkout" : "Change plan",
                      size: "sm",
                      variant: free ? "primary" : "secondary",
                      disabled: billingSample,
                      onClick: SubmittedForm({ form: "change-plan" }),
                    }),
                  ],
                ),
              }),
            ]),
        ...(plan === undefined
          ? []
          : [
              settingsRow(h, {
                label: "This month so far",
                description: plan.provisional
                  ? "Estimated from provisional prices: the plan’s price plus usage beyond what it includes"
                  : "Estimated: the plan’s price plus usage beyond what it includes",
                control: h.span(
                  [...styleAttributes(h, styles.value)],
                  [formatCents(plan.monthToDateCents)],
                ),
              }),
            ]),
      ],
    }),
    ...(plans === null ? [] : [planComparison(h, { plans, current: plan?.subscribed ?? null })]),
    settingsGroup(h, {
      title: "Payment",
      footnote:
        "Payments are processed by Stripe; card details never reach Akter. The billing portal opens in a new tab.",
      rows: [
        settingsRow(h, {
          label:
            billing.card === null
              ? "No payment method"
              : `${titleCase(billing.card.brand)} ending ${billing.card.lastFour}`,
          description: [
            ...(billing.card === null
              ? []
              : [
                  `Expires ${formatExpiry({ month: billing.card.expiryMonth, year: billing.card.expiryYear })}`,
                ]),
            ...(billing.billingEmail === null ? [] : [`receipts to ${billing.billingEmail}`]),
          ].join(" · "),
          control: button(h, {
            label: billing.card === null ? "Add" : "Update",
            variant: "ghost",
            size: "sm",
            trailingIcon: "external",
            disabled: billingSample,
            onClick: SubmittedForm({ form: "stripe-portal" }),
          }),
        }),
        settingsRow(h, {
          label: "Monthly spend limit",
          description:
            plan === undefined
              ? "Applies once you’re on a paid plan."
              : free
                ? `Applies once you’re on a paid plan; ${plan.name} stops at what it includes instead.`
                : "New commands that would pass it are refused; work already admitted finishes.",
          control: select(h, {
            name: spendLimitKey,
            label: "Monthly spend limit",
            value: model.choices[spendLimitKey] ?? spendLimitValue(billing.spendLimit.limitCents),
            disabled: billingSample,
            options: spendLimitOptions(billing.spendLimit.limitCents),
            onChange: (value) => ChoseSetting({ key: spendLimitKey, value }),
          }),
        }),
        ...(limit === null ||
        limit === undefined ||
        limit === billing.spendLimit.limitCents ||
        !spendLimitReached({ limitCents: limit, billing })
          ? []
          : [
              settingsRow(h, {
                label: "New commands will be refused right away",
                tone: "danger",
                control: button(h, {
                  label: "Save limit",
                  size: "sm",
                  disabled: billingSample,
                  onClick: SubmittedForm({ form: "spend-limit" }),
                }),
              }),
            ]),
        ...(limit === null || limit === undefined || limit === 0
          ? []
          : [
              h.div(
                [...styleAttributes(h, styles.padded)],
                [
                  meter(h, {
                    label: "Spend this month",
                    value: dollars(billing.spendLimit.currentCents),
                    limit: dollars(limit),
                    format: formatCurrency,
                  }),
                ],
              ),
            ]),
      ],
    }),
    settingsGroup(h, {
      title: "Invoices",
      rows:
        page.invoices.length === 0
          ? [settingsRow(h, { label: "No invoices yet" })]
          : page.invoices.map((invoice) => {
              const pdf = isSample(page, "invoices") ? null : invoice.pdfUrl
              return settingsRow(h, {
                label: formatMonth(invoice.periodStart),
                description: `${invoice.number} · ${invoice.status}${pdf === null ? "" : " · PDF"}`,
                href: pdf ?? undefined,
                attributes:
                  pdf === null
                    ? []
                    : [
                        h.Target("_blank"),
                        h.Rel("noopener noreferrer"),
                        h.AriaLabel(`Invoice ${invoice.number} PDF, opens in a new tab`),
                      ],
                control: h.span(
                  [...styleAttributes(h, styles.muted)],
                  [formatCurrency(dollars(invoice.amountCents))],
                ),
              })
            }),
    }),
  ])
}

const meterFormat = (unit: UsageMeter["unit"]): ((value: number) => string) =>
  Match.value(unit).pipe(
    Match.when("count", () => formatCompact),
    Match.when("hours", () => formatInteger),
    Match.when("gigabytes", () => formatGigabytes),
    Match.exhaustive,
  )

/**
 * What a meter's numbers mean, from the pricing the control plane reports with them. `capped` names
 * the allowances the edge stops new commands at, as its cap state reports them; an unbound
 * organization has no plan to describe, so its meters say nothing about caps or prices.
 */
const meterDetail = (
  entry: UsageMeter,
  usage: Usage,
  capped: { readonly commands: boolean; readonly storage: boolean; readonly unbound: boolean },
): string | undefined => {
  const overage =
    entry.overageCostCents > 0 && !capped.unbound
      ? `${formatCents(entry.overageCostCents)} over the allowance so far`
      : undefined
  if (entry.meter === "commands")
    return [
      `Commands plus reads, a read counting as ${String(usage.pricing.readCommandWeight)} of a command`,
      ...(capped.commands
        ? ["This plan stops new commands here until next month; reads keep working"]
        : []),
      ...(overage === undefined ? [] : [overage]),
    ].join(". ")
  if (entry.meter === "storageGb")
    return [
      "Average stored this month",
      ...(capped.unbound
        ? []
        : [
            capped.storage
              ? "This plan pauses new commands while a tenant’s latest sample is at the cap; reads keep working"
              : `${formatCents(usage.pricing.storagePerGbCents)} per GB-month beyond the allowance`,
          ]),
      ...(overage === undefined ? [] : [overage]),
    ].join(". ")
  return overage
}

/** The latest storage sample, and for a storage cap how close its largest tenant is to it. */
const storedNow = (h: H, usage: Usage): ReadonlyArray<Html> => {
  const sample = usage.latestStorageSample
  if (sample === null) return []
  const cap = usage.caps.find((entry) => entry.cap === "storage")
  return [
    settingsRow(h, {
      label: "Stored now",
      description: [
        `Latest sample across serving deployments, taken ${formatInstant(sample.sampledAt)} UTC`,
        ...(cap?.limit == null
          ? []
          : [
              `The largest tenant holds ${formatGigabytes(cap.used / 1e9)} of the ${formatGigabytes(cap.limit / 1e9)} each tenant may store`,
            ]),
      ].join(". "),
      control: h.span([...styleAttributes(h, styles.value)], [formatGigabytes(sample.bytes / 1e9)]),
    }),
  ]
}

/**
 * Organization › Usage: this period's meters against the plan, commands per day, and cost by
 * project. The control plane still prices an unbound organization's usage with Free's allowances,
 * so for one the page shows plain counts and no allowance, price or estimate.
 */
export const usageScreen = ({ h, page }: ScreenInput<SettingsPage>): Screen => {
  const { usage } = page
  if (usage === null)
    return page.unknownPlan ? unknownPlanScreen(h, "Usage") : screen(h, "Usage", [])
  const month = formatPeriod(usage.period)
  const notice = capNotice({ caps: usage.caps, period: usage.period })
  const bounded = (name: "commands" | "storage") =>
    usage.caps.some((cap) => cap.cap === name && cap.limit !== null && cap.reason === undefined)
  const capped = {
    commands: bounded("commands"),
    storage: bounded("storage"),
    unbound: isUnbound(usage.caps),
  }
  const reads = usage.meters.find((entry) => entry.meter === "reads")
  return screen(h, "Usage", [
    ...(notice === undefined ? [] : [capNoticeView(h, notice)]),
    settingsGroup(h, {
      title: month,
      footnote:
        usage.pricing.provisional && !capped.unbound ? "Paid prices are provisional." : undefined,
      rows: [
        ...usage.meters.flatMap((entry) => {
          if (entry.meter === "reads") return []
          const format = meterFormat(entry.unit)
          const detail = meterDetail(entry, usage, capped)
          const shown =
            entry.included > 0 && !capped.unbound
              ? h.div(
                  [...styleAttributes(h, styles.padded)],
                  [
                    meter(h, {
                      label: entry.label,
                      value: entry.used,
                      limit: entry.included,
                      format,
                      detail,
                    }),
                  ],
                )
              : settingsRow(h, {
                  label: entry.label,
                  description:
                    detail ?? (capped.unbound ? undefined : "Nothing included in this plan"),
                  control: h.span([...styleAttributes(h, styles.value)], [format(entry.used)]),
                })
          return entry.meter === "storageGb" ? [shown, ...storedNow(h, usage)] : [shown]
        }),
        ...(reads === undefined
          ? []
          : [
              settingsRow(h, {
                label: "Reads",
                description: `Counted in commands above as ${formatCompact(reads.used * usage.pricing.readCommandWeight)}`,
                control: h.span([...styleAttributes(h, styles.value)], [formatCompact(reads.used)]),
              }),
            ]),
      ],
    }),
    settingsGroup(h, {
      title: "Commands per day",
      rows: [
        h.div(
          [...styleAttributes(h, styles.padded)],
          [
            barChart(h, {
              label: `Commands per day in ${month}`,
              height: 140,
              xTicks: 5,
              data: usage.commandsPerDay.map((entry, index) => ({
                key: entry.day,
                label: formatDay(entry.day),
                value: entry.commands,
                highlight: index === usage.commandsPerDay.length - 1,
              })),
            }),
          ],
        ),
      ],
    }),
    settingsGroup(h, {
      title: "By project",
      footnote: capped.unbound
        ? undefined
        : `Estimates share out usage beyond the allowance; the plan’s price is not split.${usage.pricing.provisional ? " They use provisional prices." : ""}`,
      rows: [
        dataTable(h, {
          label: "Usage by project",
          bare: true,
          empty: "No project has run commands this period.",
          columns: [
            { key: "project", label: "Project", width: "minmax(0, 1fr)", mono: true },
            { key: "commands", label: "Commands", width: "6rem", align: "end" },
            { key: "reads", label: "Reads", width: "5.5rem", align: "end" },
            ...(capped.unbound
              ? []
              : [{ key: "estimate", label: "Estimate", width: "5.5rem", align: "end" as const }]),
          ],
          rows: usage.projects.map((project) => ({
            key: project.id,
            cells: [
              project.name,
              formatCompact(project.commands),
              project.reads === null ? "—" : formatCompact(project.reads),
              ...(capped.unbound ? [] : [formatCents(project.estimatedCostCents)]),
            ],
          })),
        }),
      ],
    }),
  ])
}

/** Organization › Audit log: who changed what, newest first. */
export const auditScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen => {
  const filter = model.choices["auditFilter"] ?? "all"
  const entries =
    filter === "all" ? page.audit : page.audit.filter((entry) => entry.action.startsWith(filter))
  return screen(h, "Audit log", [
    h.div(
      [...styleAttributes(h, styles.inline)],
      [
        select(h, {
          name: "auditFilter",
          label: "Filter events",
          value: filter,
          options: [
            { value: "all", label: "All events" },
            ...[...new Set(page.audit.map((entry) => entry.action.split(".")[0] ?? entry.action))]
              .toSorted()
              .map((prefix) => ({ value: prefix, label: titleCase(prefix) })),
          ],
          onChange: (value) => ChoseSetting({ key: "auditFilter", value }),
        }),
      ],
    ),
    dataTable(h, {
      label: "Audit log",
      empty: "No events of this kind.",
      columns: [
        { key: "time", label: "Time (UTC)", width: "8.5rem", muted: true },
        { key: "person", label: "Who", width: "minmax(0, 1fr)", hideBelow: "compact" },
        { key: "action", label: "Action", width: "minmax(0, 1fr)", mono: true },
        {
          key: "target",
          label: "Target",
          width: "minmax(0, 1.2fr)",
          mono: true,
          muted: true,
          hideBelow: "narrow",
        },
      ],
      rows: entries.map((entry) => ({
        key: entry.id,
        cells: [formatInstant(entry.at), entry.person, entry.action, entry.target],
      })),
    }),
    ...(page.auditTruncated
      ? [
          h.p(
            [...styleAttributes(h, styles.muted)],
            ["Showing the latest events; older ones are not loaded."],
          ),
        ]
      : []),
  ])
}
