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
  formatInstant,
  formatMonth,
  formatPeriod,
  titleCase,
} from "./format.ts"
import { memberRoleKey, parseSpendLimit, spendLimitKey, spendLimitValue } from "./keys.ts"
import type { SettingsPage, UsageMeter } from "./model.ts"
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
                    onInput: (value) => ChangedField({ name: "invite-email", value }),
                  }),
                ],
              ),
              select(h, {
                name: "invite-role",
                label: "Role",
                value: model.choices["inviteRole"] ?? "member",
                size: "md",
                options: assignableRoles,
                onChange: (value) => ChoseSetting({ key: "inviteRole", value }),
              }),
              button(h, { label: "Invite", variant: "primary", type: "submit" }),
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

/** Organization › Billing: the Stripe subscription, payment method, spend limit and invoices. */
export const billingScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen => {
  const { billing } = page
  if (billing === null) return screen(h, "Billing", [])
  const limit = parseSpendLimit(
    model.choices[spendLimitKey] ?? spendLimitValue(billing.spendLimit.limitCents),
  )
  return screen(h, "Billing", [
    settingsGroup(h, {
      title: "Plan",
      rows: [
        settingsRow(h, {
          label: billing.plan.name,
          description: [
            billing.plan.basePriceCents === 0
              ? "Free"
              : `${formatCurrency(dollars(billing.plan.basePriceCents))} a month plus usage`,
            ...(billing.plan.renewsAt === null
              ? []
              : [`Renews ${formatDate(billing.plan.renewsAt)}`]),
          ].join(". "),
          control: button(h, {
            label: billing.plan.id === "free" ? "Upgrade" : "Change plan",
            size: "sm",
            onClick: SubmittedForm({ form: "change-plan" }),
          }),
        }),
        settingsRow(h, {
          label: "This month so far",
          control: h.span(
            [...styleAttributes(h, styles.value)],
            [formatCurrency(dollars(billing.plan.monthToDateCents))],
          ),
        }),
      ],
    }),
    settingsGroup(h, {
      title: "Payment",
      footnote: "Payments are processed by Stripe. Card details never reach Akter.",
      rows: [
        settingsRow(h, {
          label:
            billing.card === null
              ? "No payment method"
              : `${billing.card.brand} ending ${billing.card.lastFour}`,
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
            onClick: SubmittedForm({ form: "stripe-portal" }),
          }),
        }),
        settingsRow(h, {
          label: "Monthly spend limit",
          description: "At the limit, new deploys pause; running actors keep running.",
          control: select(h, {
            name: spendLimitKey,
            label: "Monthly spend limit",
            value: model.choices[spendLimitKey] ?? spendLimitValue(billing.spendLimit.limitCents),
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
      rows: page.invoices.map((invoice) =>
        settingsRow(h, {
          label: formatMonth(invoice.periodStart),
          description: `${invoice.number} · ${invoice.status}`,
          href: invoice.pdfUrl ?? undefined,
          control: h.span(
            [...styleAttributes(h, styles.muted)],
            [formatCurrency(dollars(invoice.amountCents))],
          ),
        }),
      ),
    }),
  ])
}

const meterFormat = (unit: UsageMeter["unit"]) => (value: number) =>
  unit === "count"
    ? formatCompact(value)
    : unit === "hours"
      ? formatInteger(value)
      : value >= 1000
        ? `${String(value / 1000)} TB`
        : `${formatInteger(value)} GB`

/** Organization › Usage: this period's meters against the plan, commands per day, and cost by project. */
export const usageScreen = ({ h, page }: ScreenInput<SettingsPage>): Screen => {
  const { usage } = page
  if (usage === null) return screen(h, "Usage", [])
  const month = formatPeriod(usage.period)
  return screen(h, "Usage", [
    settingsGroup(h, {
      title: month,
      rows: usage.meters.map((entry) => {
        const format = meterFormat(entry.unit)
        return entry.included > 0
          ? h.div(
              [...styleAttributes(h, styles.padded)],
              [
                meter(h, {
                  label: entry.label,
                  value: entry.used,
                  limit: entry.included,
                  format,
                }),
              ],
            )
          : settingsRow(h, {
              label: entry.label,
              description: "Nothing included in this plan",
              control: h.span([...styleAttributes(h, styles.value)], [format(entry.used)]),
            })
      }),
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
      rows: [
        dataTable(h, {
          label: "Usage by project",
          bare: true,
          empty: "No project has run commands this period.",
          columns: [
            { key: "project", label: "Project", width: "minmax(0, 1fr)", mono: true },
            { key: "commands", label: "Commands", width: "6rem", align: "end" },
            { key: "estimate", label: "Estimate", width: "5.5rem", align: "end" },
          ],
          rows: usage.projects.map((project) => ({
            key: project.id,
            cells: [
              project.name,
              formatCompact(project.commands),
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
