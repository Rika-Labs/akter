import { Dialog } from "../shell/model.ts"
import {
  button,
  codeBlock,
  dataTable,
  iconButton,
  type IconName,
  input,
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
import type { SettingsPage } from "./model.ts"
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

const environments = [
  { id: "production", label: "Production" },
  { id: "staging", label: "Staging" },
  { id: "development", label: "Development" },
] as const

/** Project › Environment: the variables and secrets each environment's runners start with. */
export const environmentScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen => {
  const selected = model.choices["environment"] ?? "production"
  const variables = page.variables.filter((variable) => variable.environment === selected)
  return screen(
    h,
    "Environment",
    [
      h.div(
        [...styleAttributes(h, styles.inline)],
        [
          tabs(h, {
            label: "Environment",
            variant: "segmented",
            selected,
            items: environments.map((environment) => ({
              id: environment.id,
              label: environment.label,
              onSelect: ChoseSetting({ key: "environment", value: environment.id }),
            })),
          }),
          h.span([...styleAttributes(h, styles.grow)], []),
          button(h, {
            label: "Add variable",
            variant: "primary",
            size: "sm",
            icon: "plus",
            onClick: OpenedDialog({ dialog: Dialog.AddVariable() }),
          }),
        ],
      ),
      dataTable(h, {
        label: `${selected} variables`,
        columns: [
          { key: "name", label: "Name", width: "minmax(0, 1.3fr)", mono: true },
          {
            key: "value",
            label: "Value",
            width: "minmax(0, 1fr)",
            mono: true,
            muted: true,
          },
          {
            key: "used",
            label: "Used by",
            width: "minmax(0, 0.9fr)",
            muted: true,
            hideBelow: "compact",
          },
          { key: "updated", label: "Updated", width: "6.5rem", align: "end", hideBelow: "narrow" },
        ],
        rows: variables.map((variable) => ({
          key: `${variable.environment}-${variable.name}`,
          cells: [variable.name, variable.value, variable.usedBy, variable.updated],
        })),
      }),
      h.p(
        [...styleAttributes(h, styles.muted)],
        [
          "Changing a variable starts a new deploy. Actors move to the new runners without dropping a turn.",
        ],
      ),
    ],
    "Secrets and variables your runners start with. Secret values are never shown again.",
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
            description: region.place,
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
            description: region.place,
            control: button(h, {
              label: "Add",
              size: "sm",
              icon: "plus",
              onClick: SubmittedForm({ form: `add-region-${region.id}` }),
            }),
          }),
        ),
    }),
  ])

const domainTones = { Active: "live", "Pending DNS": "attention", Default: "idle" } as const

/** Project › Domains: the default domain, custom domains and the DNS a pending one needs. */
export const domainsScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen =>
  screen(h, "Domains", [
    h.form(
      [h.OnSubmit(SubmittedForm({ form: "add-domain" })), ...styleAttributes(h, styles.inline)],
      [
        input(h, {
          name: "domain",
          label: "Domain",
          value: model.fields["domain"] ?? "",
          placeholder: "api.example.com",
          required: true,
          style: styles.grow,
          onInput: (value) => ChangedField({ name: "domain", value }),
        }),
        button(h, { label: "Add domain", variant: "primary", type: "submit" }),
      ],
    ),
    settingsGroup(h, {
      rows: page.domains.map((domain) =>
        settingsRow(h, {
          label: domain.host,
          mono: true,
          description: domain.detail,
          control: status(h, { tone: domainTones[domain.status], label: domain.status }),
        }),
      ),
    }),
    settingsGroup(h, {
      title: "DNS for ws.acme.dev",
      rows: [
        h.div(
          [...styleAttributes(h, styles.padded)],
          [
            codeBlock(h, {
              code: "ws.acme.dev.   CNAME   storefront.akter.cloud.",
              language: "text",
              onCopy: CopiedText({ text: "storefront.akter.cloud", label: "CNAME target" }),
            }),
          ],
        ),
      ],
    }),
  ])

/** Project › API keys: keys for the CLI, CI and services, and the endpoints they call. */
export const keysScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen =>
  screen(h, "API keys", [
    settingsGroup(h, {
      action: button(h, {
        label: "Create key",
        variant: "primary",
        size: "sm",
        icon: "plus",
        onClick: OpenedDialog({ dialog: Dialog.CreateKey() }),
      }),
      title: "Keys",
      rows: page.keys
        .filter((key) => !model.revoked.includes(key.name))
        .map((key) =>
          settingsRow(h, {
            label: key.name,
            mono: true,
            description: `${key.masked} · ${key.scope} · last used ${key.lastUsed}`,
            control: button(h, {
              label: "Revoke",
              variant: "ghost",
              size: "sm",
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
            onClick: CopiedText({ text: endpoint.value, label: `${endpoint.label} endpoint` }),
            tooltip: "top",
          }),
        }),
      ),
    }),
    settingsGroup(h, {
      title: "Call an actor over HTTP",
      rows: [
        h.div(
          [...styleAttributes(h, styles.padded)],
          [
            codeBlock(h, {
              language: "shell",
              code: `# every command is an endpoint\n$ curl -X POST https://storefront.akter.cloud/actors/Order/ord_8f2c/Place \\\n    -H "authorization: Bearer $AKTER_KEY" \\\n    -H "idempotency-key: cmd_7Hq2" \\\n    -d '{ "lines": [{ "sku": "mug", "quantity": 2 }] }'`,
              onCopy: CopiedText({
                text: "curl -X POST https://storefront.akter.cloud/actors/Order/ord_8f2c/Place",
                label: "request",
              }),
            }),
          ],
        ),
      ],
    }),
  ])

const integrationIcons = new Map<string, IconName>([
  ["github", "github"],
  ["slack", "slack"],
  ["datadog", "datadog"],
  ["opentelemetry", "telemetry"],
  ["pagerduty", "pager"],
])

/** Project › Integrations: source control, chat, observability and paging. */
export const integrationsScreen = ({ h, page }: ScreenInput<SettingsPage>): Screen =>
  screen(h, "Integrations", [
    settingsGroup(h, {
      rows: page.integrations.map((integration) =>
        settingsRow(h, {
          label: integration.name,
          description: integration.detail,
          icon: integrationIcons.get(integration.id) ?? "plug",
          href: integration.connected ? Routes.settingsIntegrations() : undefined,
          control: integration.connected
            ? status(h, { tone: "live", label: "Connected" })
            : button(h, {
                label: "Connect",
                size: "sm",
                onClick: SubmittedForm({ form: `connect-${integration.id}` }),
              }),
        }),
      ),
    }),
  ])
