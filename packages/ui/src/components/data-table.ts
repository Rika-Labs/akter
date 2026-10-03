import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { accessibility } from "../design/accessibility.ts"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { entranceStyles, motionStyles } from "../design/motion.ts"
import { densityMarker } from "../markers.stylex.ts"
import { borders, colors, conditions, dimensions, space, typography } from "../tokens.stylex.ts"

const styles = stylex.create({
  root: {
    minWidth: 0,
    overflowX: "auto",
    borderBlockStartWidth: borders.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  bare: { borderBlockStartWidth: 0 },
  row: {
    position: "relative",
    display: "grid",
    alignItems: "center",
    gap: "0.875rem",
    minHeight: {
      default: dimensions.tableRow,
      [stylex.when.ancestor("[data-density='compact']", densityMarker)]: "2rem",
    },
    paddingInline: space.xs,
    borderBlockEndWidth: borders.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  interactive: {
    backgroundColor: { default: "transparent", ":hover": colors.accent },
    transitionProperty: "background-color",
  },
  selected: { backgroundColor: colors.selected },
  head: {
    minHeight: dimensions.tableHead,
    color: colors.subtleForeground,
    fontSize: typography.caption,
  },
  muted: { color: colors.mutedForeground },
  cell: {
    minWidth: 0,
    paddingBlock: space.s,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  wrap: { whiteSpace: "normal", overflowWrap: "anywhere" },
  end: { textAlign: "end", fontVariantNumeric: "tabular-nums", justifySelf: "end" },
  numeric: { color: colors.mutedForeground },
  mono: { fontFamily: typography.mono, fontSize: typography.caption },
  raised: { position: "relative", zIndex: 1 },
  hideNarrow: { display: { default: "block", [conditions.narrow]: "none" } },
  hideCompact: { display: { default: "block", [conditions.compact]: "none" } },
  link: {
    color: "inherit",
    textDecoration: "none",
    "::after": { content: "''", position: "absolute", inset: 0 },
  },
  empty: {
    paddingBlock: space.xl,
    paddingInline: space.xs,
    color: colors.mutedForeground,
    borderBlockEndWidth: borders.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
})

const templates = stylex.create({
  columns: (wide: string, narrow: string, compact: string) => ({
    gridTemplateColumns: {
      default: wide,
      [conditions.narrow]: narrow,
      [conditions.compact]: compact,
    },
  }),
})

/** One column: its header, its grid track, its alignment, and when it gives way on small screens. */
export interface TableColumn {
  readonly key: string
  readonly label: string
  readonly width: string
  readonly align?: "start" | "end"
  readonly mono?: boolean
  readonly muted?: boolean
  readonly wrap?: boolean
  readonly hideBelow?: "narrow" | "compact"
}

/** One row. With `href` the whole row opens it; its first cell carries the link's name. */
export interface TableRow {
  readonly key: string
  readonly cells: ReadonlyArray<Html | string>
  readonly href?: string
  readonly tone?: "default" | "muted"
  readonly selected?: boolean
  readonly fresh?: boolean
}

/**
 * A list of records in aligned columns: a quiet header, hairline row dividers, and end-aligned
 * tabular numbers. Columns flagged `hideBelow` drop out on narrow screens instead of scrolling.
 */
export type DataTableConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: string
    columns: ReadonlyArray<TableColumn>
    rows: ReadonlyArray<TableRow>
    empty?: string
    density?: "default" | "compact"
    showHeader?: boolean
    bare?: boolean
  }>

const visible = (columns: ReadonlyArray<TableColumn>, below: "narrow" | "compact"): string =>
  columns
    .flatMap((column) =>
      column.hideBelow === undefined || (below === "narrow" && column.hideBelow === "compact")
        ? [column.width]
        : [],
    )
    .join(" ")

const render = <Message>(h: HtmlBuilder<Message>, config: DataTableConfig<Message>): Html => {
  const template = templates.columns(
    config.columns.map((column) => column.width).join(" "),
    visible(config.columns, "narrow"),
    visible(config.columns, "compact"),
  )
  const cellStyles = (column: TableColumn | undefined) => [
    styles.cell,
    column?.align === "end" && styles.end,
    column?.mono === true && styles.mono,
    column?.muted === true && styles.muted,
    column?.wrap === true && styles.wrap,
    column?.hideBelow === "narrow" && styles.hideNarrow,
    column?.hideBelow === "compact" && styles.hideCompact,
  ]
  const header =
    config.showHeader === false
      ? h.empty
      : h.div(
          [h.Role("row"), ...styleAttributes(h, styles.row, styles.head, template)],
          config.columns.map((column) =>
            h.div(
              [
                h.Role("columnheader"),
                ...styleAttributes(h, cellStyles({ ...column, mono: false })),
              ],
              [column.label],
            ),
          ),
        )
  const rows =
    config.rows.length === 0 && config.empty !== undefined
      ? [
          h.div(
            [h.Role("row"), ...styleAttributes(h, styles.empty)],
            [h.div([h.Role("cell")], [config.empty])],
          ),
        ]
      : config.rows.map((row) =>
          h.keyed("div")(
            row.key,
            [
              h.Role("row"),
              h.DataAttribute("row", row.key),
              ...styleAttributes(
                h,
                styles.row,
                template,
                row.href !== undefined && styles.interactive,
                row.tone === "muted" && styles.muted,
                row.selected === true && styles.selected,
                row.fresh === true && entranceStyles.fade,
                motionStyles.fast,
              ),
            ],
            row.cells.map((cell, index) => {
              const column = config.columns[index]
              const content =
                index === 0 && row.href !== undefined
                  ? h.a(
                      [
                        h.Href(row.href),
                        ...styleAttributes(h, styles.link, accessibility.focusRing),
                      ],
                      [cell],
                    )
                  : index > 0 && row.href !== undefined
                    ? h.span([...styleAttributes(h, styles.raised)], [cell])
                    : cell
              return h.div(
                [
                  h.Role("cell"),
                  ...styleAttributes(
                    h,
                    cellStyles(column),
                    column?.align === "end" && styles.numeric,
                  ),
                ],
                [content],
              )
            }),
          ),
        )
  return h.div(
    [
      h.Role("table"),
      h.AriaLabel(config.label),
      h.DataAttribute("slot", "data-table"),
      h.DataAttribute("density", config.density ?? "default"),
      ...(config.attributes ?? []),
      ...styleAttributes(
        h,
        styles.root,
        densityMarker,
        config.bare === true && styles.bare,
        config.style,
      ),
    ],
    [
      config.showHeader === false ? h.empty : h.div([h.Role("rowgroup")], [header]),
      h.div([h.Role("rowgroup")], rows),
    ],
  )
}

/** A data table of records, with row links, numeric alignment and responsive columns. */
export const dataTable: {
  <Message>(h: HtmlBuilder<Message>, config: DataTableConfig<Message>): Html
  <Message>(config: DataTableConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
