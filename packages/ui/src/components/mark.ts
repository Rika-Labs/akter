import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { mark as figures, markViewBox } from "../brand/mark.ts"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { colors } from "../tokens.stylex.ts"

const styles = stylex.create({
  root: { display: "block", flexShrink: 0, color: colors.foreground },
  stroke: { stroke: "currentColor", fill: "none" },
})

/** The segmented Ak at `size` pixels. With a `label` it is announced; without, it is decorative. */
export type MarkConfig<Message> = SlotConfig<Message> &
  Readonly<{
    size: number
    label?: string
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: MarkConfig<Message>): Html =>
  h.svg(
    [
      h.ViewBox(markViewBox),
      h.Width(String(config.size)),
      h.Height(String(config.size)),
      ...(config.label === undefined
        ? [h.AriaHidden(true)]
        : [h.Role("img"), h.AriaLabel(config.label)]),
      h.DataAttribute("slot", "mark"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.root, config.style),
    ],
    figures.map((figure) =>
      (figure.tag === "polyline" ? h.polyline : h.line)(
        [
          ...Object.entries(figure.attributes).map(([key, value]) =>
            h.Attribute(key, String(value)),
          ),
          h.StrokeWidth(String(figure.strokeWidth ?? 3.4)),
          ...styleAttributes(h, styles.stroke),
        ],
        [],
      ),
    ),
  )

/** The single-ink segmented Ak mark, drawn from the brand geometry in the current text colour. */
export const mark: {
  <Message>(h: HtmlBuilder<Message>, config: MarkConfig<Message>): Html
  <Message>(config: MarkConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
