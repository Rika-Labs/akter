import { select, settingsRow, switchControl } from "@akter/ui"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ChoseSetting, type Message, ToggledSetting } from "../shell/message.ts"
import type { Model } from "../shell/model.ts"

/** What a settings row needs: the builder, the Model it reads, and the preference it is bound to. */
export interface PreferenceRow {
  readonly h: HtmlBuilder<Message>
  readonly model: Model
  readonly key: string
  readonly label: string
  readonly description?: string
  readonly disabled?: boolean
}

/** A switch row bound to one named preference. */
export const toggleRow = (row: PreferenceRow & Readonly<{ initial?: boolean }>): Html =>
  settingsRow(row.h, {
    label: row.label,
    description: row.description,
    control: switchControl(row.h, {
      checked: row.model.toggles[row.key] ?? row.initial ?? false,
      disabled: row.disabled,
      label: row.label,
      onToggle: ToggledSetting({ key: row.key }),
      attributes: [row.h.DataAttribute("setting", row.key)],
    }),
  })

/** A select row bound to one named choice. */
export const choiceRow = (
  row: PreferenceRow &
    Readonly<{
      options: ReadonlyArray<Readonly<{ value: string; label: string }>>
      initial?: string
    }>,
): Html =>
  settingsRow(row.h, {
    label: row.label,
    description: row.description,
    control: select(row.h, {
      name: row.key,
      label: row.label,
      disabled: row.disabled,
      value: row.model.choices[row.key] ?? row.initial ?? row.options[0]?.value ?? "",
      options: row.options,
      onChange: (value) => ChoseSetting({ key: row.key, value }),
    }),
  })
