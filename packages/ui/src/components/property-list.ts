import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { borders, colors, space, typography } from "../tokens.stylex.ts"

const styles = stylex.create({
  list: { display: "grid", minWidth: 0 },
  item: {
    display: "grid",
    gridTemplateColumns: "6rem minmax(0, 1fr)",
    alignItems: "center",
    gap: space.md,
    minHeight: "1.875rem",
  },
  wide: { gridTemplateColumns: "9rem minmax(0, 1fr)" },
  ruled: {
    minHeight: "2.25rem",
    borderBlockEndWidth: borders.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  term: { color: colors.mutedForeground },
  value: { minWidth: 0, overflowWrap: "anywhere", fontVariantNumeric: "tabular-nums" },
  mono: { fontFamily: typography.mono, fontSize: typography.caption },
})

/** One property: a muted term and its value. */
export interface Property {
  readonly label: string
  readonly value: Html | string
  readonly mono?: boolean
}

/** Key/value facts about one thing; `ruled` separates rows with hairlines for longer lists. */
export type PropertyListConfig<Message> = SlotConfig<Message> &
  Readonly<{
    items: ReadonlyArray<Property>
    layout?: "aside" | "wide"
    ruled?: boolean
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: PropertyListConfig<Message>): Html =>
  h.dl(
    [
      h.DataAttribute("slot", "property-list"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.list, config.style),
    ],
    config.items.map((item) =>
      h.div(
        [
          ...styleAttributes(
            h,
            styles.item,
            config.layout === "wide" && styles.wide,
            config.ruled === true && styles.ruled,
          ),
        ],
        [
          h.dt([...styleAttributes(h, styles.term)], [item.label]),
          h.dd(
            [...styleAttributes(h, styles.value, item.mono === true && styles.mono)],
            [item.value],
          ),
        ],
      ),
    ),
  )

/** A property list. */
export const propertyList: {
  <Message>(h: HtmlBuilder<Message>, config: PropertyListConfig<Message>): Html
  <Message>(config: PropertyListConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
