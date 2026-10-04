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
  formatDate,
  formatDay,
  formatExpiry,
  formatGigabytes,
  formatInstant,
  formatMonth,
  formatPeriod,
  titleCase,
} from "./format.ts"
import { capReached } from "../quota/model.ts"
import { capNoticeView } from "../quota/view.ts"
import {
  memberRoleKey,
  parseSpendLimit,
  planChoiceKey,
  planChoices,
  spendLimitKey,
  spendLimitValue,
} from "./keys.ts"
import type { Billing, PaymentStatus, SettingsPage, Usage, UsageMeter } from "./model.ts"
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

const planPrice = (billing: Billing): string =>
  billing.plan.basePriceCents === 0
    ? "No monthly charge"
    : `${formatCurrency(dollars(billing.plan.basePriceCents))} a month plus usage${billing.plan.provisional ? " (provisional price)" : ""}`

/** How the plan reads: its price, when it renews, and why paid limits are withheld if they are. */
const planDescription = (billing: Billing): string => {
  const problem =
    billing.plan.paymentStatus === null ? undefined : paymentProblems[billing.plan.paymentStatus]
  const withheld =
    billing.plan.subscribed !== billing.plan.id
      ? `${problem ?? "Payment is pending"}, so ${billing.plan.name} limits apply until ${titleCase(billing.plan.subscribed)} is paid for`
      : problem
  return [
    planPrice(billing),
    ...(billing.plan.renewsAt === null ? [] : [`renews ${formatDate(billing.plan.renewsAt)}`]),
    ...(withheld === undefined ? [] : [withheld]),
  ].join(" · ")
}

/** Free's monthly allowances, each a hard cap, as the usage report states them. */
const freeAllowances = (usage: Usage): string | undefined => {
  const commands = usage.meters.find((entry) => entry.meter === "commands")
  const storage = usage.meters.find((entry) => entry.meter === "storageGb")
  if (commands === undefined) return undefined
  return [
    `${formatCompact(commands.included)} commands a month (a read counts as ${String(usage.pricing.readCommandWeight)} of a command)`,
    ...(storage === undefined ? [] : [`${formatGigabytes(storage.included)} of storage`]),
  ].join(" and ")
}

/** Organization › Billing: the plan and its change, payment method, spend limit and invoices. */
export const billingScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen => {
  const { billing, usage } = page
  if (billing === null) return screen(h, "Billing", [])
  const billingSample = isSample(page, "billing")
  const free = billing.plan.id === "free" && billing.plan.subscribed === "free"
  const choices = planChoices(billing.plan.subscribed)
  const allowances = free && usage !== null ? freeAllowances(usage) : undefined
  const limit = parseSpendLimit(
    model.choices[spendLimitKey] ?? spendLimitValue(billing.spendLimit.limitCents),
  )
  return screen(h, "Billing", [
    settingsGroup(h, {
      title: "Plan",
      rows: [
        settingsRow(h, { label: billing.plan.name, description: planDescription(billing) }),
        ...(allowances === undefined
          ? []
          : [
              settingsRow(h, {
                label: "Included",
                description: `${allowances}. Both are hard caps: at either one, new commands are refused while reads keep working.`,
              }),
            ]),
        ...(choices.length === 0
          ? []
          : [
              settingsRow(h, {
                label: free ? "Upgrade" : "Change plan",
                description: free
                  ? "Checkout opens on Stripe, which shows the price before you pay."
                  : "Invoiced right away; the new plan applies once the payment goes through.",
                control: h.span(
                  [...styleAttributes(h, styles.inline)],
                  [
                    select(h, {
                      name: planChoiceKey,
                      label: free ? "Plan to upgrade to" : "Plan to change to",
                      value: model.choices[planChoiceKey] ?? choices[0] ?? "",
                      size: "sm",
                      disabled: billingSample,
                      options: choices.map((plan) => ({ value: plan, label: titleCase(plan) })),
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
        settingsRow(h, {
          label: "This month so far",
          description: "Estimated: the plan’s price plus usage beyond what it includes",
          control: h.span(
            [...styleAttributes(h, styles.value)],
            [formatCurrency(dollars(billing.plan.monthToDateCents))],
          ),
        }),
      ],
    }),
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
          description: free
            ? "Applies once you’re on a paid plan; Free stops at what it includes instead."
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

/** What a meter's numbers mean, from the pricing the control plane reports with them. */
const meterDetail = (entry: UsageMeter, usage: Usage, free: boolean): string | undefined => {
  const overage =
    entry.overageCostCents > 0
      ? `${formatCurrency(dollars(entry.overageCostCents))} over the allowance so far`
      : undefined
  if (entry.meter === "commands")
    return [
      `Commands plus reads, a read counting as ${String(usage.pricing.readCommandWeight)} of a command`,
      ...(free ? ["Free stops new commands here until next month; reads keep working"] : []),
      ...(overage === undefined ? [] : [overage]),
    ].join(". ")
  if (entry.meter === "storageGb")
    return [
      "Average stored this month",
      free
        ? "Free pauses new commands while a tenant’s latest sample is at the cap; reads keep working"
        : `${formatCurrency(dollars(usage.pricing.storagePerGbCents))} per GB-month beyond the allowance`,
      ...(overage === undefined ? [] : [overage]),
    ].join(". ")
  return overage
}

/** Organization › Usage: this period's meters against the plan, commands per day, and cost by project. */
export const usageScreen = ({ h, page }: ScreenInput<SettingsPage>): Screen => {
  const { usage, billing } = page
  if (usage === null) return screen(h, "Usage", [])
  const month = formatPeriod(usage.period)
  const free = billing?.plan.id === "free"
  const cap = billing === null ? undefined : capReached({ billing, usage })
  const reads = usage.meters.find((entry) => entry.meter === "reads")
  return screen(h, "Usage", [
    ...(cap === undefined ? [] : [capNoticeView(h, cap)]),
    settingsGroup(h, {
      title: month,
      footnote: usage.pricing.provisional ? "Paid prices are provisional." : undefined,
      rows: [
        ...usage.meters.flatMap((entry) => {
          if (entry.meter === "reads") return []
          const format = meterFormat(entry.unit)
          const detail = meterDetail(entry, usage, free)
          return entry.included > 0
            ? [
                h.div(
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
                ),
              ]
            : [
                settingsRow(h, {
                  label: entry.label,
                  description: detail ?? "Nothing included in this plan",
                  control: h.span([...styleAttributes(h, styles.value)], [format(entry.used)]),
                }),
              ]
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
      footnote: "Estimates share out usage beyond the allowance; the plan’s price is not split.",
      rows: [
        dataTable(h, {
          label: "Usage by project",
          bare: true,
          empty: "No project has run commands this period.",
          columns: [
            { key: "project", label: "Project", width: "minmax(0, 1fr)", mono: true },
            { key: "commands", label: "Commands", width: "6rem", align: "end" },
            { key: "reads", label: "Reads", width: "5.5rem", align: "end" },
            { key: "estimate", label: "Estimate", width: "5.5rem", align: "end" },
          ],
          rows: usage.projects.map((project) => ({
            key: project.id,
            cells: [
              project.name,
              formatCompact(project.commands),
              project.reads === null ? "—" : formatCompact(project.reads),
              formatCurrency(dollars(project.estimatedCostCents)),
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
