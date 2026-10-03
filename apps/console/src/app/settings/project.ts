import { Dialog } from "../shell/model.ts"
import type { EnvironmentName } from "@akter/cloud-api"
import {
  button,
  codeBlock,
  dataTable,
  iconButton,
  type IconName,
  input,
  select,
  settingsGroup,
  settingsPage,
  settingsRow,
  status,
  styleAttributes,
  tabs,
} from "@akter/ui"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Routes from "../navigation/routes.ts"
import {
  ChangedField,
  ChoseSetting,
  CopiedText,
  type Message,
  OpenedDialog,
  SubmittedForm,
} from "../shell/message.ts"
import type { Screen, ScreenInput } from "../shell/screen.ts"
import { formatDate, formatInstant } from "./format.ts"
import type { Domain, Integration, SettingsPage } from "./model.ts"
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

const environmentLabels: Readonly<Record<EnvironmentName, string>> = {
  production: "Production",
  staging: "Staging",
  dev: "Development",
}

/** Project › Environment: the variables each environment's runners start with. Values are write-only. */
export const environmentScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen => {
  const selected =
    page.environments.find((entry) => entry.environment === model.choices["environment"]) ??
    page.environments.find((entry) => entry.environment === "production") ??
    page.environments[0]
  return screen(
    h,
    "Environment",
    selected === undefined
      ? [h.p([...styleAttributes(h, styles.muted)], ["This project has no environments yet."])]
      : [
          h.div(
            [...styleAttributes(h, styles.inline)],
            [
              tabs(h, {
                label: "Environment",
                variant: "segmented",
                selected: selected.environment,
                items: page.environments.map((entry) => ({
                  id: entry.environment,
                  label: environmentLabels[entry.environment],
                  onSelect: ChoseSetting({ key: "environment", value: entry.environment }),
                })),
              }),
              h.span([...styleAttributes(h, styles.grow)], []),
              button(h, {
                label: "Add variable",
                variant: "primary",
                size: "sm",
                icon: "plus",
                disabled: isSample(page, "environments"),
                onClick: OpenedDialog({ dialog: Dialog.AddVariable() }),
              }),
            ],
          ),
          dataTable(h, {
            label: `${selected.environment} variables`,
            empty: "No variables in this environment.",
            columns: [
              { key: "name", label: "Name", width: "minmax(0, 1.3fr)", mono: true },
              {
                key: "used",
                label: "Used by",
                width: "minmax(0, 1fr)",
                muted: true,
                hideBelow: "compact",
              },
              {
                key: "updated",
                label: "Updated (UTC)",
                width: "12rem",
                align: "end",
                hideBelow: "narrow",
              },
            ],
            rows: selected.variables.map((variable) => ({
              key: `${selected.environment}-${variable.name}`,
              cells: [
                variable.name,
                variable.usedBy.length === 0 ? "—" : variable.usedBy.join(", "),
                variable.updatedBy === null
                  ? formatInstant(variable.updatedAt)
                  : `${formatInstant(variable.updatedAt)} · ${variable.updatedBy}`,
              ],
            })),
          }),
          h.p(
            [...styleAttributes(h, styles.muted)],
            ["A new value takes effect on the next deploy."],
          ),
        ],
    "Secrets and variables your runners start with. Values are write-only and never shown again.",
  )
}

/** Project › Regions: the home region, replicas, and regions you can add. */
export const regionsSettingsScreen = ({ h, page }: ScreenInput<SettingsPage>): Screen =>
  screen(h, "Regions", [
    settingsGroup(h, {
      title: "Running in",
      rows: page.regions
        .filter((region) => region.role !== "Available")
        .map((region) =>
          settingsRow(h, {
            label: region.id,
            mono: true,
            description: region.city,
            control: status(h, {
              tone: "live",
              label: region.role === "Home" ? "Home region" : "Replica",
            }),
          }),
        ),
      footnote: "A tenant's actors and rows stay in its home region; replicas serve reads.",
    }),
    settingsGroup(h, {
      title: "Available",
      rows: page.regions
        .filter((region) => region.role === "Available")
        .map((region) =>
          settingsRow(h, {
            label: region.id,
            mono: true,
            description: region.city,
            control: button(h, {
              label: "Add",
              size: "sm",
              icon: "plus",
              disabled: isSample(page, "regions"),
              onClick: SubmittedForm({ form: `add-region-${region.id}` }),
            }),
          }),
        ),
    }),
  ])

const domainStates: Readonly<
  Record<Domain["status"], Readonly<{ tone: "live" | "attention"; label: string }>>
> = {
  active: { tone: "live", label: "Active" },
  verifying: { tone: "attention", label: "Verifying" },
  pending: { tone: "attention", label: "Pending DNS" },
}

const dnsText = (domain: Domain): string =>
  domain.records.map((record) => `${record.type}  ${record.name}  ${record.value}`).join("\n")

/** Project › Domains: custom domains and the DNS records each one still needs. */
export const domainsScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen => {
  const disabled = isSample(page, "domains")
  return screen(h, "Domains", [
    h.form(
      [h.OnSubmit(SubmittedForm({ form: "add-domain" })), ...styleAttributes(h, styles.inline)],
      [
        input(h, {
          name: "domain",
          label: "Domain",
          value: model.fields["domain"] ?? "",
          placeholder: "api.example.com",
          required: true,
          disabled,
          style: styles.grow,
          onInput: (value) => ChangedField({ name: "domain", value }),
        }),
        select(h, {
          name: "domain-environment",
          label: "Environment",
          value: model.choices["domain-environment"] ?? "production",
          size: "md",
          disabled,
          options: Object.entries(environmentLabels).map(([value, label]) => ({ value, label })),
          onChange: (value) => ChoseSetting({ key: "domain-environment", value }),
        }),
        button(h, { label: "Add domain", variant: "primary", type: "submit", disabled }),
      ],
    ),
    settingsGroup(h, {
      rows: page.domains.map((domain) =>
        settingsRow(h, {
          label: domain.hostname,
          mono: true,
          description: `Serves ${environmentLabels[domain.environment].toLowerCase()}`,
          control: h.span(
            [...styleAttributes(h, styles.inline)],
            [
              status(h, domainStates[domain.status]),
              domain.status === "active"
                ? h.empty
                : button(h, {
                    label: "Verify",
                    size: "sm",
                    disabled,
                    onClick: SubmittedForm({ form: `verify-domain:${domain.id}` }),
                    attributes: [h.AriaLabel(`Verify ${domain.hostname}`)],
                  }),
            ],
          ),
        }),
      ),
    }),
    ...page.domains
      .filter((domain) => domain.status !== "active" && domain.records.length > 0)
      .map((domain) =>
        settingsGroup(h, {
          title: `DNS for ${domain.hostname}`,
          rows: [
            h.div(
              [...styleAttributes(h, styles.padded)],
              [
                codeBlock(h, {
                  code: dnsText(domain),
                  language: "text",
                  onCopy: disabled
                    ? undefined
                    : CopiedText({ text: dnsText(domain), label: "DNS records" }),
                }),
              ],
            ),
          ],
        }),
      ),
  ])
}

/** Project › API keys: keys for the CLI, CI and services, and the endpoints they call. */
export const keysScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen =>
  screen(h, "API keys", [
    settingsGroup(h, {
      action: button(h, {
        label: "Create key",
        variant: "primary",
        size: "sm",
        icon: "plus",
        disabled: isSample(page, "keys"),
        onClick: OpenedDialog({ dialog: Dialog.CreateKey() }),
      }),
      title: "Keys",
      rows: page.keys
        .filter((key) => !model.revoked.includes(key.name))
        .map((key) =>
          settingsRow(h, {
            label: key.name,
            mono: true,
            description: [
              key.tail,
              `${key.permission} access, ${key.projectScoped ? "one project" : "whole organization"}`,
              key.lastUsedAt === null
                ? "never used"
                : `last used ${formatInstant(key.lastUsedAt)} UTC`,
              ...(key.expiresAt === null ? [] : [`expires ${formatDate(key.expiresAt)}`]),
            ].join(" · "),
            control: button(h, {
              label: "Revoke",
              variant: "ghost",
              size: "sm",
              disabled: isSample(page, "keys"),
              onClick: OpenedDialog({ dialog: Dialog.RevokeKey({ name: key.name }) }),
              attributes: [h.AriaLabel(`Revoke ${key.name}`)],
            }),
          }),
        ),
    }),
    settingsGroup(h, {
      title: "Endpoints",
      rows: page.endpoints.map((endpoint) =>
        settingsRow(h, {
          label: endpoint.label,
          description: endpoint.value,
          control: iconButton(h, {
            label: `Copy ${endpoint.label} endpoint`,
            icon: "copy",
            onClick: isSample(page, "endpoints")
              ? undefined
              : CopiedText({ text: endpoint.value, label: `${endpoint.label} endpoint` }),
            attributes: isSample(page, "endpoints") ? [h.Disabled(true)] : [],
            tooltip: "top",
          }),
        }),
      ),
    }),
  ])

const integrationIcons: Readonly<Record<Integration["kind"], IconName>> = {
  github: "github",
  slack: "slack",
  datadog: "datadog",
  opentelemetry: "telemetry",
  pagerduty: "pager",
}

/** Project › Integrations: source control, chat, observability and paging. */
export const integrationsScreen = ({ h, page }: ScreenInput<SettingsPage>): Screen =>
  screen(h, "Integrations", [
    settingsGroup(h, {
      rows: page.integrations.map((integration) =>
        settingsRow(h, {
          label: integration.name,
          description: integration.detail,
          icon: integrationIcons[integration.kind],
          href:
            integration.status === "connected" && !isSample(page, "integrations")
              ? Routes.settingsIntegrations()
              : undefined,
          control:
            integration.status === "connected"
              ? status(h, { tone: "live", label: "Connected" })
              : h.span(
                  [...styleAttributes(h, styles.inline)],
                  [
                    integration.status === "error"
                      ? status(h, { tone: "attention", label: "Needs attention" })
                      : h.empty,
                    button(h, {
                      label: integration.status === "error" ? "Reconnect" : "Connect",
                      size: "sm",
                      disabled: isSample(page, "integrations"),
                      onClick: SubmittedForm({ form: `connect-${integration.kind}` }),
                    }),
                  ],
                ),
        }),
      ),
    }),
  ])
