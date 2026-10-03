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
import { choiceRow } from "./rows.ts"
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

const roles = [
  { value: "Owner", label: "Owner" },
  { value: "Admin", label: "Admin" },
  { value: "Member", label: "Member" },
  { value: "Viewer", label: "Viewer" },
]

/** Organization › General: its name, URL, defaults, and deletion. */
export const organizationScreen = ({ h, model }: ScreenInput<SettingsPage>): Screen =>
  screen(h, "Organization", [
    settingsGroup(h, {
      rows: [
        settingsRow(h, {
          label: "Name",
          control: input(h, {
            name: "org-name",
            label: "Organization name",
            value: model.fields["org-name"] ?? model.workspace.organization,
            size: "sm",
            onInput: (value) => ChangedField({ name: "org-name", value }),
          }),
        }),
        settingsRow(h, {
          label: "URL",
          description: `akter.cloud/${model.fields["org-slug"] ?? "acme"}`,
          control: input(h, {
            name: "org-slug",
            label: "Organization URL",
            value: model.fields["org-slug"] ?? "acme",
            size: "sm",
            mono: true,
            onInput: (value) => ChangedField({ name: "org-slug", value }),
          }),
        }),
        choiceRow({
          h,
          model,
          key: "receiptRetention",
          label: "Receipt retention",
          description: "How long a retried command still returns its stored result.",
          options: [
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
          ],
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
    settingsGroup(h, {
      title: "Danger zone",
      rows: [
        settingsRow(h, {
          label: "Delete storefront",
          tone: "danger",
          description: "Stops every runner and erases its database after a 7-day hold.",
          control: button(h, {
            label: "Delete project",
            size: "sm",
            onClick: OpenedDialog({ dialog: Dialog.DeleteProject({ project: "storefront" }) }),
          }),
        }),
      ],
    }),
  ])

/** Organization › Members: who has access, in which role, and pending invitations. */
export const membersScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen =>
  screen(h, "Members", [
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
          value: model.choices["inviteRole"] ?? "Member",
          size: "md",
          options: roles.slice(1),
          onChange: (value) => ChoseSetting({ key: "inviteRole", value }),
        }),
        button(h, { label: "Invite", variant: "primary", type: "submit" }),
      ],
    ),
    settingsGroup(h, {
      rows: page.members.map((member) =>
        settingsRow(h, {
          label: member.pending ? member.email : member.name,
          description: member.pending
            ? `Invited as ${member.role} · sent 2 days ago`
            : member.email,
          control: member.pending
            ? button(h, {
                label: "Resend",
                variant: "ghost",
                size: "sm",
                onClick: SubmittedForm({ form: "resend-invite" }),
              })
            : member.role === "Owner"
              ? h.span([...styleAttributes(h, styles.muted)], ["Owner"])
              : select(h, {
                  name: `role-${member.email}`,
                  label: `Role for ${member.name}`,
                  value: model.choices[`role-${member.email}`] ?? member.role,
                  options: roles.slice(1),
                  onChange: (value) => ChoseSetting({ key: `role-${member.email}`, value }),
                }),
        }),
      ),
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

/** Organization › Billing: the Stripe subscription, payment method, spend limit and invoices. */
export const billingScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen => {
  const limit = Number(model.choices["spendLimit"] ?? String(page.spendLimit))
  return screen(h, "Billing", [
    settingsGroup(h, {
      title: "Plan",
      rows: [
        settingsRow(h, {
          label: page.plan.name,
          description: `${page.plan.price}. Renews ${page.plan.renews}.`,
          control: button(h, {
            label: "Change plan",
            size: "sm",
            onClick: SubmittedForm({ form: "change-plan" }),
          }),
        }),
        settingsRow(h, {
          label: "This month so far",
          control: h.span(
            [...styleAttributes(h, styles.value)],
            [formatCurrency(page.monthToDate)],
          ),
        }),
      ],
    }),
    settingsGroup(h, {
      title: "Payment",
      footnote: "Payments are processed by Stripe. Card details never reach Akter.",
      rows: [
        settingsRow(h, {
          label: `${page.card.brand} ending ${page.card.last4}`,
          description: `Expires ${page.card.expires} · receipts to ${page.billingEmail}`,
          control: button(h, {
            label: "Update",
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
            name: "spendLimit",
            label: "Monthly spend limit",
            value: String(limit),
            options: [
              { value: "250", label: "$250" },
              { value: "500", label: "$500" },
              { value: "1000", label: "$1,000" },
              { value: "0", label: "No limit" },
            ],
            onChange: (value) => ChoseSetting({ key: "spendLimit", value }),
          }),
        }),
        ...(limit === 0
          ? []
          : [
              h.div(
                [...styleAttributes(h, styles.padded)],
                [
                  meter(h, {
                    label: "Spend this month",
                    value: page.monthToDate,
                    limit,
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
          label: invoice.period,
          description: invoice.number,
          href: `#${invoice.number}`,
          control: h.span([...styleAttributes(h, styles.muted)], [formatCurrency(invoice.amount)]),
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

/** Organization › Usage: this month's meters against the plan, commands per day, and cost by project. */
export const usageScreen = ({ h, page }: ScreenInput<SettingsPage>): Screen =>
  screen(h, "Usage", [
    settingsGroup(h, {
      title: page.usageMonth,
      rows: page.meters.map((usage) =>
        h.div(
          [...styleAttributes(h, styles.padded)],
          [
            meter(h, {
              label: usage.label,
              value: usage.used,
              limit: usage.included,
              format: meterFormat(usage.unit),
            }),
          ],
        ),
      ),
    }),
    settingsGroup(h, {
      title: "Commands per day",
      rows: [
        h.div(
          [...styleAttributes(h, styles.padded)],
          [
            barChart(h, {
              label: `Commands per day in ${page.usageMonth}`,
              height: 140,
              xTicks: 5,
              data: page.commandsPerDay.map((value, index) => ({
                key: String(index),
                label: `Sep ${String(index + 1)}`,
                value,
                highlight: index === page.commandsPerDay.length - 1,
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
          columns: [
            { key: "project", label: "Project", width: "minmax(0, 1fr)", mono: true },
            { key: "commands", label: "Commands", width: "5.5rem", align: "end" },
            {
              key: "hours",
              label: "Runner hours",
              width: "6.5rem",
              align: "end",
              hideBelow: "compact",
            },
            { key: "storage", label: "Storage", width: "5rem", align: "end", hideBelow: "compact" },
            { key: "estimate", label: "Estimate", width: "5.5rem", align: "end" },
          ],
          rows: page.projects.map((project) => ({
            key: project.project,
            cells: [
              project.project,
              project.commands,
              project.runnerHours,
              project.storage,
              formatCurrency(project.estimate),
            ],
          })),
        }),
      ],
    }),
  ])

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
            { value: "deploy", label: "Deploys" },
            { value: "member", label: "Members" },
            { value: "key", label: "API keys" },
            { value: "variable", label: "Variables" },
          ],
          onChange: (value) => ChoseSetting({ key: "auditFilter", value }),
        }),
      ],
    ),
    dataTable(h, {
      label: "Audit log",
      empty: "No events of this kind.",
      columns: [
        { key: "time", label: "Time", width: "7.5rem", muted: true },
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
        key: entry.key,
        cells: [entry.time, entry.person, entry.action, entry.target],
      })),
    }),
    h.p(
      [...styleAttributes(h, styles.muted)],
      [status(h, { tone: "idle", label: "Kept for 400 days" })],
    ),
  ])
}
