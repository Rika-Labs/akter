import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { Children, SlotConfig } from "../design/contracts.ts"
import { colors, conditions, dimensions, space, typography } from "../tokens.stylex.ts"

const styles = stylex.create({
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "1.75rem",
    width: "100%",
    maxWidth: dimensions.pageMax,
    paddingBlock: { default: "1.75rem", [conditions.narrow]: space.lg },
    paddingInline: { default: space.xxl, [conditions.narrow]: space.lg },
    paddingBlockEnd: space.huge,
  },
  header: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: space.lg,
    flexWrap: "wrap",
  },
  titleBlock: { display: "grid", gap: space.s, minWidth: 0 },
  title: {
    fontSize: typography.heading,
    fontWeight: typography.weightStrong,
    letterSpacing: "-0.3px",
    lineHeight: typography.leadingTight,
    overflowWrap: "anywhere",
  },
  mono: {
    fontFamily: typography.mono,
    fontSize: "1.25rem",
    fontWeight: 500,
    letterSpacing: "-0.4px",
  },
  description: { color: colors.mutedForeground, maxWidth: "40rem" },
  actions: { display: "flex", alignItems: "center", gap: space.s, flexWrap: "wrap" },
  section: { display: "flex", flexDirection: "column", minWidth: 0 },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    minHeight: "1.75rem",
    marginBlockEnd: space.sm,
  },
  sectionTitle: { fontSize: "0.875rem", fontWeight: typography.weightStrong },
  sectionMeta: { color: colors.subtleForeground, fontSize: typography.caption },
  sectionTitles: { display: "flex", alignItems: "baseline", gap: space.sm, minWidth: 0 },
  columns: {
    display: "grid",
    gap: "1.75rem",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      [conditions.narrow]: "minmax(0, 1fr)",
    },
  },
  wideLeft: {
    gridTemplateColumns: {
      default: "minmax(0, 2fr) minmax(0, 1fr)",
      [conditions.narrow]: "minmax(0, 1fr)",
    },
  },
})

/** The padded column a product page's content sits in, below the top bar. */
export const pageBody: {
  <Message>(h: HtmlBuilder<Message>, children: Children): Html
  (children: Children): <Message>(h: HtmlBuilder<Message>) => Html
} = Function.dual(2, <Message>(h: HtmlBuilder<Message>, children: Children): Html =>
  h.div([h.DataAttribute("slot", "page-body"), ...styleAttributes(h, styles.body)], [...children]),
)

/** The page title, with an optional one-line description and actions. */
export type PageHeaderConfig<Message> = SlotConfig<Message> &
  Readonly<{
    title: string
    description?: string
    mono?: boolean
    actions?: Children
  }>

const renderHeader = <Message>(h: HtmlBuilder<Message>, config: PageHeaderConfig<Message>): Html =>
  h.div(
    [...(config.attributes ?? []), ...styleAttributes(h, styles.header, config.style)],
    [
      h.div(
        [...styleAttributes(h, styles.titleBlock)],
        [
          h.h1(
            [...styleAttributes(h, styles.title, config.mono === true && styles.mono)],
            [config.title],
          ),
          config.description === undefined
            ? h.empty
            : h.p([...styleAttributes(h, styles.description)], [config.description]),
        ],
      ),
      config.actions === undefined
        ? h.empty
        : h.div([...styleAttributes(h, styles.actions)], [...config.actions]),
    ],
  )

/** A product page's heading. */
export const pageHeader: {
  <Message>(h: HtmlBuilder<Message>, config: PageHeaderConfig<Message>): Html
  <Message>(config: PageHeaderConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, renderHeader)

/** A titled block of a page: a small heading, a quiet note beside it, and actions on the right. */
export type SectionConfig<Message> = SlotConfig<Message> &
  Readonly<{
    title: string
    meta?: string
    actions?: Children
    children: Children
    id?: string
  }>

const renderSection = <Message>(h: HtmlBuilder<Message>, config: SectionConfig<Message>): Html => {
  const headingId = `${config.id ?? config.title.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")}-heading`
  return h.section(
    [
      h.AriaLabelledBy(headingId),
      h.DataAttribute("slot", "section"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.section, config.style),
    ],
    [
      h.div(
        [...styleAttributes(h, styles.sectionHead)],
        [
          h.div(
            [...styleAttributes(h, styles.sectionTitles)],
            [
              h.h2([h.Id(headingId), ...styleAttributes(h, styles.sectionTitle)], [config.title]),
              config.meta === undefined
                ? h.empty
                : h.span([...styleAttributes(h, styles.sectionMeta)], [config.meta]),
            ],
          ),
          config.actions === undefined
            ? h.empty
            : h.div([...styleAttributes(h, styles.actions)], [...config.actions]),
        ],
      ),
      ...config.children,
    ],
  )
}

/** A page section. */
export const section: {
  <Message>(h: HtmlBuilder<Message>, config: SectionConfig<Message>): Html
  <Message>(config: SectionConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, renderSection)

/** Two page columns: `even` halves, or `wide-left` two thirds and one third. Stacks when narrow. */
export type ColumnsConfig = Readonly<{ layout: "even" | "wide-left"; children: Children }>

/** Side-by-side page sections. */
export const columns: {
  <Message>(h: HtmlBuilder<Message>, config: ColumnsConfig): Html
  <Message>(config: ColumnsConfig): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, <Message>(h: HtmlBuilder<Message>, config: ColumnsConfig): Html =>
  h.div(
    [...styleAttributes(h, styles.columns, config.layout === "wide-left" && styles.wideLeft)],
    [...config.children],
  ),
)
