import type { SeriesWindow } from "@akter/cloud-api"
import { dropdownMenu, styleAttributes } from "@akter/ui"
import * as stylex from "@stylexjs/stylex"
import { colors } from "@akter/ui/tokens.stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ChoseSetting, type Message } from "../shell/message.ts"
import { seriesWindows, windowName } from "./time.ts"

const styles = stylex.create({
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    height: "1.75rem",
    paddingInline: "0.625rem",
    borderRadius: "6px",
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
    backgroundColor: { default: "transparent", ":hover": colors.accent },
  },
})

type WindowMenuInput = Readonly<{ id: string; selected: SeriesWindow; disabled: boolean }>

const capitalised = (words: string): string => `${words.charAt(0).toUpperCase()}${words.slice(1)}`

/**
 * The window a page's series cover. Choosing one stores it and reloads the page; sample pages keep
 * the control disabled because they cannot reload from the API.
 */
export const windowMenu: {
  (input: WindowMenuInput): (h: HtmlBuilder<Message>) => Html
  (h: HtmlBuilder<Message>, input: WindowMenuInput): Html
} = Function.dual(2, (h: HtmlBuilder<Message>, input: WindowMenuInput): Html =>
  dropdownMenu(h, {
    id: input.id,
    label: "Time range",
    placement: "below-end",
    entries: seriesWindows.map((window) => ({
      kind: "item" as const,
      label: capitalised(windowName[window]),
      checked: window === input.selected,
      onSelect: ChoseSetting({ key: "seriesWindow", value: window }),
    })),
    trigger: (attributes) =>
      h.button(
        [
          h.Type("button"),
          h.Disabled(input.disabled),
          ...attributes,
          h.AriaLabel(`Time range: ${windowName[input.selected]}`),
          ...styleAttributes(h, styles.trigger),
        ],
        [input.selected],
      ),
  }),
)
