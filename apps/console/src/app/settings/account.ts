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
import type { NotificationEvent } from "@akter/cloud-api"
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
import { type NotificationChannel, notificationKey } from "./keys.ts"
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

const environmentOptions = [
  { value: "production", label: "Production" },
  { value: "staging", label: "Staging" },
  { value: "dev", label: "Development" },
]

/** UTC, this device's zone, and the stored zone when it is neither, so the saved value always shows. */
const timeZoneOptions = (current: string | undefined) => {
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone
  const zones = [...new Set(["UTC", device, ...(current === undefined ? [] : [current])])]
  return zones.map((zone) => ({
    value: zone,
    label: zone === device && zone !== "UTC" ? `${zone} (this device)` : zone,
  }))
}

/** Account › General: interface defaults and the live tail's behaviour. */
export const generalScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen =>
  screen(h, "General", [
    settingsGroup(h, {
      title: "Interface",
      rows: [
        choiceRow({
          h,
          model,
          key: "defaultEnvironment",
          label: "Default environment",
          initial: page.preferences?.defaultEnvironment,
          options: environmentOptions,
        }),
        toggleRow({
          h,
          model,
          key: "openInNewTab",
          label: "Open actor links in a new tab",
          initial: page.preferences?.openActorLinksInNewTab,
        }),
        choiceRow({
          h,
          model,
          key: "timeZone",
          label: "Time zone",
          initial: page.preferences?.timeZone,
          options: timeZoneOptions(model.choices["timeZone"] ?? page.preferences?.timeZone),
        }),
      ],
    }),
    settingsGroup(h, {
      title: "Live tail",
      rows: [
        toggleRow({
          h,
          model,
          key: "pauseOnScroll",
          label: "Pause when I scroll",
          initial: page.preferences?.pauseLiveTailOnScroll,
        }),
        toggleRow({
          h,
          model,
          key: "showReplayed",
          label: "Show replayed commands",
          initial: page.preferences?.showReplayedCommands,
        }),
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
  ])

/** Account › Profile: your name, email and how you signed in. */
export const profileScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen => {
  const profile = page.profile
  if (profile === null) return screen(h, "Profile", [])
  return screen(h, "Profile", [
    settingsGroup(h, {
      rows: [
        settingsRow(h, {
          label: profile.name,
          description: profile.email,
          control: avatar(h, { name: profile.name, size: "lg" }),
        }),
        settingsRow(h, {
          label: "Display name",
          control: h.form(
            [h.OnSubmit(SubmittedForm({ form: "profile" })), ...styleAttributes(h, styles.inline)],
            [
              input(h, {
                name: "display-name",
                label: "Display name",
                value: model.fields["display-name"] ?? profile.name,
                size: "sm",
                required: true,
                onInput: (value) => ChangedField({ name: "display-name", value }),
              }),
              button(h, { label: "Save", size: "sm", type: "submit" }),
            ],
          ),
        }),
        settingsRow(h, {
          label: "Email",
          description: profile.email,
          control: status(h, {
            tone: profile.emailVerified ? "live" : "attention",
            label: profile.emailVerified ? "Verified" : "Not verified",
          }),
        }),
      ],
    }),
    settingsGroup(h, {
      title: "Sign-in",
      rows: [
        settingsRow(h, {
          label: "Password",
          control: button(h, {
            label: "Change",
            size: "sm",
            onClick: SubmittedForm({ form: "password" }),
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
}

const notificationEvents: ReadonlyArray<Readonly<{ event: NotificationEvent; label: string }>> = [
  { event: "deploy_failed", label: "A deploy fails or rolls back" },
  { event: "dead_letter", label: "A job lands in dead letters" },
  { event: "spend_threshold", label: "Spend crosses a threshold" },
]

/** Account › Notifications: which events reach you by email and in Slack. */
export const notificationsScreen = ({ h, model, page }: ScreenInput<SettingsPage>): Screen => {
  const rows = (channel: NotificationChannel) =>
    notificationEvents.map(({ event, label }) =>
      toggleRow({
        h,
        model,
        key: notificationKey({ channel, event }),
        label,
        initial: page.notifications.find((entry) => entry.event === event)?.[channel],
      }),
    )
  return screen(h, "Notifications", [
    settingsGroup(h, {
      title: "Email",
      description: model.workspace.person.email,
      rows: rows("email"),
    }),
    settingsGroup(h, {
      title: "Slack",
      description: "Connect Slack in Integrations to send these to a channel.",
      rows: rows("slack"),
    }),
  ])
}
