import {
  button,
  codeBlock,
  dialog,
  field,
  input,
  select,
  styleAttributes,
  textarea,
} from "@akter/ui"
import { colors, space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { Match, Option, Predicate } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
  ChangedField,
  ChoseSetting,
  ClosedDialog,
  ConfirmedDialog,
  CopiedText,
  type Message,
} from "./message.ts"
import { isQuotaKind } from "../quota/errors.ts"
import { billingLink } from "../quota/view.ts"
import { canSendCommand } from "./action.ts"
import type { Dialog, Model } from "./model.ts"
import { dialogId } from "./update.ts"

const styles = stylex.create({
  note: { color: colors.mutedForeground, fontSize: typography.small },
  mono: { fontFamily: typography.mono, fontSize: typography.small, color: colors.foreground },
  pair: { display: "grid", gap: space.lg },
  full: { width: "100%" },
  inputFrame: { borderWidth: 0, padding: 0, margin: 0, minWidth: 0 },
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
      disabled: model.sendingCommand,
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
            label: "Permission",
            control: select(h, {
              name: "key-scope",
              value: model.choices["keyScope"] ?? "write",
              size: "md",
              style: styles.full,
              options: [
                { value: "read", label: "Read only" },
                { value: "write", label: "Read and write" },
                { value: "admin", label: "Admin" },
              ],
              onChange: (value) => ChoseSetting({ key: "keyScope", value }),
            }),
          }),
          field(h, {
            id: "key-project",
            label: "Applies to",
            control: select(h, {
              name: "key-project",
              value: model.choices["keyProject"] ?? "project",
              size: "md",
              style: styles.full,
              options: [
                { value: "project", label: "This project" },
                { value: "organization", label: "Whole organization" },
              ],
              onChange: (value) => ChoseSetting({ key: "keyProject", value }),
            }),
          }),
        ],
        confirm: "Create key",
        danger: false,
        ready: true,
      }),
      AddVariable: () => ({
        title: "Add a variable",
        description: "Values are write-only and never read back. Enter a new value to replace one.",
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
      SendCommand: ({ address, scope }) => ({
        title: "Send a command",
        description: `To ${address} in ${scope.environment} (${scope.projectId}). Reusing a command ID returns its stored receipt.`,
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
            control: h.fieldset(
              [h.Disabled(model.sendingCommand), ...styleAttributes(h, styles.inputFrame)],
              [
                textarea(h, {
                  name: "command-payload",
                  value: model.fields["command-payload"] ?? "{}",
                  rows: 4,
                  mono: true,
                  describedBy: "command-payload-description",
                  onInput: (value) => ChangedField({ name: "command-payload", value }),
                }),
              ],
            ),
          }),
          text(h, model, {
            id: "command-id",
            label: "Command ID (optional)",
            placeholder: "Leave empty to generate a retry-safe ID",
            mono: true,
          }),
          model.sendingCommand
            ? h.p(
                [h.Role("status"), ...styleAttributes(h, styles.note)],
                ["Sending… Closing this dialog does not cancel the actor’s turn."],
              )
            : h.empty,
          Option.match(model.commandError, {
            onNone: () => h.empty,
            onSome: ({ kind, message }) =>
              h.p(
                [h.Role("alert"), ...styleAttributes(h, styles.note)],
                isQuotaKind(kind) ? [`${message} `, billingLink(h, "Open Billing")] : [message],
              ),
          }),
          Option.match(model.commandUsedId, {
            onNone: () => h.empty,
            onSome: (id) => h.p([...styleAttributes(h, styles.mono)], [`Command ID used: ${id}`]),
          }),
          Option.match(model.commandAnswer, {
            onNone: () => h.empty,
            onSome: (answer) =>
              h.div(
                [h.Role(Predicate.isTagged(answer, "CommandRejected") ? "alert" : "status")],
                [
                  h.p(
                    [...styleAttributes(h, styles.note)],
                    [
                      Predicate.isTagged(answer, "CommandRejected")
                        ? `CommandFailed · ${answer.errorTag}${answer.replayed ? " · replayed receipt" : ""}`
                        : answer.replayed
                          ? "Replayed — returned the stored receipt."
                          : "Committed — returned the actor’s result.",
                    ],
                  ),
                  codeBlock(h, {
                    language: "json",
                    code: JSON.stringify(
                      Predicate.isTagged(answer, "CommandRejected") ? answer.error : answer.result,
                      null,
                      2,
                    ),
                  }),
                  h.p([...styleAttributes(h, styles.mono)], [`Command ID: ${answer.commandId}`]),
                ],
              ),
          }),
        ],
        confirm: "Send command",
        danger: false,
        ready:
          !model.sendingCommand &&
          canSendCommand({ page: model.page, sample: model.pageSample }) &&
          (model.fields["command-name"] ?? "").trim() !== "",
      }),
      RollBack: ({ commit }) => ({
        title: `Roll back to ${commit}?`,
        description:
          "A new deployment uses that image and environment snapshot. The current deployment stays live until it succeeds.",
        body: [],
        confirm: "Roll back",
        danger: true,
        ready: true,
      }),
      Redeploy: ({ commit }) => ({
        title: `Redeploy ${commit}?`,
        description:
          "A new deployment builds this commit again and rolls it out. The live deployment keeps serving until the new one is live.",
        body: [],
        confirm: "Redeploy",
        danger: false,
        ready: true,
      }),
      KeyCreated: ({ name, secret }) => ({
        title: `Copy ${name}`,
        description: "This is the only time the key is shown. Store it somewhere safe.",
        body: [
          codeBlock(h, {
            language: "text",
            code: secret,
            onCopy: CopiedText({ text: secret, label: "API key" }),
          }),
        ],
        confirm: "Done",
        danger: false,
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
