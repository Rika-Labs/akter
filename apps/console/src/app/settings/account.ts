import {
  avatar,
  button,
  choiceCards,
  input,
  settingsGroup,
  settingsPage,
  settingsRow,
  status,
  styleAttributes,
} from "@akter/ui"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
  ChangedField,
  ChoseTheme,
  type Message,
  SignedOut,
  SubmittedForm,
} from "../shell/message.ts"
import type { Screen, ScreenInput } from "../shell/screen.ts"
import type { Preference } from "../shell/theme.ts"
import type { SettingsPage } from "./model.ts"
import { choiceRow, toggleRow } from "./rows.ts"
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

/** Account › General: interface defaults and the live tail's behaviour. */
export const generalScreen = ({ h, model }: ScreenInput<SettingsPage>): Screen =>
  screen(h, "General", [
    settingsGroup(h, {
      title: "Interface",
      rows: [
        choiceRow({
          h,
          model,
          key: "defaultEnvironment",
          label: "Default environment",
          options: [
            { value: "production", label: "Production" },
            { value: "staging", label: "Staging" },
            { value: "development", label: "Development" },
          ],
        }),
        toggleRow({ h, model, key: "openInNewTab", label: "Open actor links in a new tab" }),
        choiceRow({
          h,
          model,
          key: "timeZone",
          label: "Time zone",
          options: [
            { value: "local", label: "Local (UTC−6)" },
            { value: "utc", label: "UTC" },
          ],
        }),
      ],
    }),
    settingsGroup(h, {
      title: "Live tail",
      rows: [
        toggleRow({ h, model, key: "pauseOnScroll", label: "Pause when I scroll" }),
        toggleRow({ h, model, key: "showReplayed", label: "Show replayed commands" }),
      ],
    }),
  ])

const preview = (h: H, scheme: "light" | "dark"): Html =>
  h.span(
    [
      ...styleAttributes(
        h,
        styles.preview,
        scheme === "light" ? styles.previewLight : styles.previewDark,
      ),
    ],
    [
      h.span(
        [...styleAttributes(h, styles.previewRail)],
        [
          h.span([...styleAttributes(h, styles.previewLine, styles.previewStrong)], []),
          h.span([...styleAttributes(h, styles.previewLine)], []),
          h.span([...styleAttributes(h, styles.previewLine)], []),
        ],
      ),
      h.span(
        [...styleAttributes(h, styles.previewCard)],
        [
          h.span([...styleAttributes(h, styles.previewLine, styles.previewStrong)], []),
          h.span([...styleAttributes(h, styles.previewLine)], []),
          h.span([...styleAttributes(h, styles.previewLine)], []),
        ],
      ),
    ],
  )

const preferences = new Map<string, Preference>([
  ["system", "system"],
  ["light", "light"],
  ["dark", "dark"],
])

/** Account › Appearance: light, dark or system, previewed in each theme's own colours. */
export const appearanceScreen = ({ h, model }: ScreenInput<SettingsPage>): Screen =>
  screen(h, "Appearance", [
    settingsGroup(h, {
      title: "Theme",
      rows: [
        h.div(
          [h.DataAttribute("slot", "theme-picker"), ...styleAttributes(h, styles.stack)],
          [
            choiceCards(h, {
              label: "Theme",
              selected: model.theme,
              onSelect: (value) => ChoseTheme({ preference: preferences.get(value) ?? "light" }),
              choices: [
                {
                  value: "system",
                  label: "System",
                  preview: h.span(
                    [...styleAttributes(h, styles.previewSplit)],
                    [preview(h, "light"), preview(h, "dark")],
                  ),
                },
                { value: "light", label: "Light", preview: preview(h, "light") },
                { value: "dark", label: "Dark", preview: preview(h, "dark") },
              ],
            }),
          ],
        ),
      ].map((child) => h.div([...styleAttributes(h, styles.padded)], [child])),
    }),
    settingsGroup(h, {
      title: "Density",
      rows: [
        toggleRow({
          h,
          model,
          key: "compactTables",
          label: "Compact tables",
          description: "Shorter rows in the live tail and long lists.",
        }),
      ],
    }),
  ])

/** Account › Profile: your name, sign-in methods and sessions. */
export const profileScreen = ({ h, model }: ScreenInput<SettingsPage>): Screen =>
  screen(h, "Profile", [
    settingsGroup(h, {
      rows: [
        settingsRow(h, {
          label: model.workspace.person.name,
          description: model.workspace.person.email,
          control: avatar(h, { name: model.workspace.person.name, size: "lg" }),
        }),
        settingsRow(h, {
          label: "Display name",
          control: input(h, {
            name: "display-name",
            label: "Display name",
            value: model.fields["display-name"] ?? model.workspace.person.name,
            size: "sm",
            onInput: (value) => ChangedField({ name: "display-name", value }),
          }),
        }),
        settingsRow(h, {
          label: "Email",
          description: model.workspace.person.email,
          control: status(h, { tone: "live", label: "Verified" }),
        }),
      ],
    }),
    settingsGroup(h, {
      title: "Sign-in",
      rows: [
        settingsRow(h, {
          label: "Password",
          description: "Last changed 3 months ago",
          control: button(h, {
            label: "Change",
            size: "sm",
            onClick: SubmittedForm({ form: "password" }),
          }),
        }),
        toggleRow({
          h,
          model,
          key: "twoFactor",
          label: "Two-factor authentication",
          description: "Ask for a code from an authenticator app.",
        }),
        settingsRow(h, {
          label: "GitHub",
          description: "Signed in as dallenpyrah",
          control: status(h, { tone: "live", label: "Connected" }),
        }),
      ],
    }),
    settingsGroup(h, {
      title: "Sessions",
      rows: [
        settingsRow(h, {
          label: "This browser",
          description: "macOS · Chrome · Salt Lake City",
          control: status(h, { tone: "live", label: "Current" }),
        }),
        settingsRow(h, {
          label: "akter CLI",
          description: "macOS · last used 2h ago",
          control: button(h, {
            label: "Revoke",
            variant: "ghost",
            size: "sm",
            onClick: SubmittedForm({ form: "session" }),
          }),
        }),
        settingsRow(h, {
          label: "Sign out",
          description: "End this session on this device.",
          control: button(h, { label: "Sign out", size: "sm", onClick: SignedOut() }),
        }),
      ],
    }),
  ])

/** Account › Notifications: which events reach you by email and in Slack. */
export const notificationsScreen = ({ h, model }: ScreenInput<SettingsPage>): Screen =>
  screen(h, "Notifications", [
    settingsGroup(h, {
      title: "Email",
      description: model.workspace.person.email,
      rows: [
        toggleRow({ h, model, key: "notify.deployFinished", label: "A deploy goes live" }),
        toggleRow({ h, model, key: "notify.deployFailed", label: "A deploy fails or rolls back" }),
        toggleRow({ h, model, key: "notify.deadLetters", label: "A job lands in dead letters" }),
        toggleRow({ h, model, key: "notify.weeklyUsage", label: "Weekly usage summary" }),
      ],
    }),
    settingsGroup(h, {
      title: "Slack",
      description: "Connect Slack in Integrations to send these to a channel.",
      rows: [
        toggleRow({ h, model, key: "notify.slackDeploys", label: "Deploys" }),
        toggleRow({ h, model, key: "notify.slackDeadLetters", label: "Dead letters" }),
      ],
    }),
  ])
