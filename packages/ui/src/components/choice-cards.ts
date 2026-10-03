import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { accessibility } from "../design/accessibility.ts"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { motionStyles } from "../design/motion.ts"
import { borders, colors, conditions, radius, space, typography } from "../tokens.stylex.ts"

const styles = stylex.create({
  group: {
    display: "grid",
    gridTemplateColumns: { default: "repeat(3, minmax(0, 1fr))", [conditions.compact]: "1fr" },
    gap: space.md,
  },
  option: {
    display: "grid",
    gap: space.sm,
    padding: 0,
    textAlign: "center",
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
    cursor: "pointer",
    backgroundColor: "transparent",
  },
  frame: {
    display: "block",
    overflow: "hidden",
    borderWidth: borders.hairline,
    borderStyle: "solid",
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    boxShadow: "0 0 0 0 transparent",
    transitionProperty: "box-shadow, border-color",
  },
  selectedFrame: {
    borderColor: colors.foreground,
    boxShadow: `0 0 0 ${borders.hairline} ${colors.foreground}`,
  },
  label: { fontSize: typography.small },
  selectedLabel: { color: colors.foreground, fontWeight: typography.weightMedium },
})

/** One choice with a small visual preview. */
export interface Choice {
  readonly value: string
  readonly label: string
  readonly preview: Html
}

/** A single-choice group shown as preview cards, such as the console theme. */
export type ChoiceCardsConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    choices: ReadonlyArray<Choice>
    selected: string
    onSelect: (value: string) => Message
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: ChoiceCardsConfig<Message>): Html =>
  h.div(
    [
      h.Role("radiogroup"),
      h.AriaLabel(config.label),
      h.DataAttribute("slot", "choice-cards"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.group, config.style),
    ],
    config.choices.map((choice) => {
      const selected = choice.value === config.selected
      return h.button(
        [
          h.Type("button"),
          h.Role("radio"),
          h.AriaChecked(selected),
          h.Tabindex(selected ? 0 : -1),
          h.OnClick(config.onSelect(choice.value)),
          h.DataAttribute("choice", choice.value),
          ...styleAttributes(h, styles.option, accessibility.focusRing),
        ],
        [
          h.span(
            [
              ...styleAttributes(
                h,
                styles.frame,
                motionStyles.fast,
                selected && styles.selectedFrame,
              ),
            ],
            [choice.preview],
          ),
          h.span(
            [...styleAttributes(h, styles.label, selected && styles.selectedLabel)],
            [choice.label],
          ),
        ],
      )
    }),
  )

/** Choice cards. */
export const choiceCards: {
  <Message>(h: HtmlBuilder<Message>, config: ChoiceCardsConfig<Message>): Html
  <Message>(config: ChoiceCardsConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
