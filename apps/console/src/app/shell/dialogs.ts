import { button, dialog, field, input, select, styleAttributes, textarea } from "@akter/ui"
import { colors, space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { Match, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
  ChangedField,
  ChoseSetting,
  ClosedDialog,
  ConfirmedDialog,
  type Message,
} from "./message.ts"
import type { Dialog, Model } from "./model.ts"
import { dialogId } from "./update.ts"

const styles = stylex.create({
  note: { color: colors.mutedForeground, fontSize: typography.small },
  mono: { fontFamily: typography.mono, fontSize: typography.small, color: colors.foreground },
  pair: { display: "grid", gap: space.lg },
  full: { width: "100%" },
})

/** One dialog's copy, body and confirm action. */
interface DialogContent {
  readonly title: string
  readonly description?: string
  readonly body: ReadonlyArray<Html>
  readonly confirm: string
  readonly danger: boolean
  readonly ready: boolean
}

const text = (
  h: HtmlBuilder<Message>,
  model: Model,
  config: Readonly<{ id: string; label: string; placeholder: string; mono?: boolean }>,
): Html =>
  field(h, {
    id: config.id,
    label: config.label,
    control: input(h, {
      name: config.id,
      value: model.fields[config.id] ?? "",
      placeholder: config.placeholder,
      mono: config.mono === true,
      onInput: (value) => ChangedField({ name: config.id, value }),
    }),
  })

const content = (h: HtmlBuilder<Message>, model: Model, current: Dialog): DialogContent =>
  Match.value(current).pipe(
    Match.tagsExhaustive({
      DiscardDeadLetter: ({ id }) => ({
        title: "Discard this dead letter?",
        description: `${id} will not run again. Its actor keeps the state from its last commit.`,
        body: [],
        confirm: "Discard",
        danger: true,
        ready: true,
      }),
      RevokeKey: ({ name }) => ({
        title: `Revoke ${name}?`,
        description: "Requests signed with it fail immediately. This cannot be undone.",
        body: [],
        confirm: "Revoke key",
        danger: true,
        ready: true,
      }),
      CreateKey: () => ({
        title: "Create an API key",
        description: "The key is shown once after you create it.",
        body: [
          text(h, model, { id: "key-name", label: "Name", placeholder: "ci-deploys", mono: true }),
          field(h, {
            id: "key-scope",
            label: "Scope",
            control: select(h, {
              name: "key-scope",
              value: model.choices["keyScope"] ?? "deploy",
              size: "md",
              style: styles.full,
              options: [
                { value: "deploy", label: "Deploy" },
                { value: "commands", label: "Send commands" },
                { value: "read", label: "Read only" },
              ],
              onChange: (value) => ChoseSetting({ key: "keyScope", value }),
            }),
          }),
        ],
        confirm: "Create key",
        danger: false,
        ready: true,
      }),
      AddVariable: () => ({
        title: "Add a variable",
        description: "Secrets are encrypted at rest and never shown again in full.",
        body: [
          text(h, model, {
            id: "variable-name",
            label: "Name",
            placeholder: "STRIPE_SECRET_KEY",
            mono: true,
          }),
          field(h, {
            id: "variable-value",
            label: "Value",
            control: textarea(h, {
              name: "variable-value",
              value: model.fields["variable-value"] ?? "",
              rows: 3,
              mono: true,
              onInput: (value) => ChangedField({ name: "variable-value", value }),
            }),
          }),
        ],
        confirm: "Save variable",
        danger: false,
        ready: true,
      }),
      SendCommand: ({ address }) => ({
        title: "Send a command",
        description: `To ${address}. It runs as one turn and returns its result.`,
        body: [
          text(h, model, {
            id: "command-name",
            label: "Command",
            placeholder: "Refund",
            mono: true,
          }),
          field(h, {
            id: "command-payload",
            label: "Payload",
            description: "JSON, decoded with the command's schema.",
            control: textarea(h, {
              name: "command-payload",
              value: model.fields["command-payload"] ?? '{ "amount": 1200 }',
              rows: 4,
              mono: true,
              describedBy: "command-payload-description",
              onInput: (value) => ChangedField({ name: "command-payload", value }),
            }),
          }),
        ],
        confirm: "Send command",
        danger: false,
        ready: true,
      }),
      RollBack: ({ commit }) => ({
        title: `Roll back to ${commit}?`,
        description: "New runners start on the previous build and actors move back as they drain.",
        body: [],
        confirm: "Roll back",
        danger: true,
        ready: true,
      }),
      DeleteProject: ({ project }) => ({
        title: `Delete ${project}?`,
        description: "Runners stop immediately; the database is kept for seven days, then erased.",
        body: [
          text(h, model, {
            id: "delete-confirm",
            label: `Type ${project} to confirm`,
            placeholder: project,
            mono: true,
          }),
        ],
        confirm: "Delete project",
        danger: true,
        ready: model.fields["delete-confirm"] === project,
      }),
    }),
  )

/** The one modal dialog, showing whichever dialog the Model has open. */
export const dialogView = (input: Readonly<{ h: HtmlBuilder<Message>; model: Model }>): Html => {
  const { h, model } = input
  const open = Option.map(model.dialog, (current) => content(h, model, current))
  return Option.match(open, {
    onNone: () =>
      dialog(h, { id: dialogId, open: false, title: "", onClose: ClosedDialog(), children: [] }),
    onSome: (current) =>
      dialog(h, {
        id: dialogId,
        open: true,
        title: current.title,
        description: current.description,
        onClose: ClosedDialog(),
        children:
          current.body.length === 0
            ? [
                h.p(
                  [...styleAttributes(h, styles.note)],
                  ["You can find this later in the audit log."],
                ),
              ]
            : [h.div([...styleAttributes(h, styles.pair)], current.body)],
        footer: [
          button(h, { label: "Cancel", variant: "ghost", onClick: ClosedDialog() }),
          button(h, {
            label: current.confirm,
            variant: current.danger ? "danger" : "primary",
            onClick: ConfirmedDialog(),
            disabled: !current.ready,
            attributes: [h.DataAttribute("dialog-confirm", "")],
          }),
        ],
      }),
  })
}
