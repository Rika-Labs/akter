import * as stylex from "@stylexjs/stylex"
import { Function, Match, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { borders, colors, radius, space, typography } from "../tokens.stylex.ts"
import { dialog } from "./dialog.ts"
import { icon, type IconName } from "./icon.ts"
import { kbd } from "./kbd.ts"

const styles = stylex.create({
  search: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: "3rem",
    paddingInline: space.lg,
    borderBlockEndWidth: borders.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
    color: colors.subtleForeground,
  },
  input: {
    flex: "1",
    minWidth: 0,
    height: "100%",
    borderWidth: 0,
    outlineStyle: "none",
    backgroundColor: "transparent",
    color: colors.foreground,
    fontSize: "0.9375rem",
  },
  list: {
    maxHeight: "min(22rem, 55dvh)",
    overflowY: "auto",
    padding: space.xs,
    scrollPaddingBlock: space.xs,
  },
  group: {
    paddingBlockStart: space.sm,
    paddingBlockEnd: space.xs,
    paddingInline: space.sm,
    color: colors.subtleForeground,
    fontSize: typography.caption,
  },
  option: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    minHeight: "2.25rem",
    paddingInline: space.sm,
    borderRadius: radius.sm,
    color: colors.foreground,
    cursor: "pointer",
  },
  active: { backgroundColor: colors.selected },
  optionIcon: { color: colors.mutedForeground, display: "inline-flex" },
  optionLabel: {
    flex: "1",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  optionDetail: {
    color: colors.subtleForeground,
    fontSize: typography.caption,
    fontFamily: typography.mono,
    whiteSpace: "nowrap",
  },
  empty: {
    paddingBlock: space.xl,
    textAlign: "center",
    color: colors.mutedForeground,
  },
  foot: {
    display: "flex",
    alignItems: "center",
    gap: space.lg,
    height: "2.5rem",
    paddingInline: space.lg,
    borderBlockStartWidth: borders.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
    color: colors.subtleForeground,
    fontSize: typography.caption,
  },
  hint: { display: "inline-flex", alignItems: "center", gap: space.s },
})

/** One command: where it is grouped, how it is found, and the Message it sends. */
export interface PaletteItem<Message> {
  readonly id: string
  readonly label: string
  readonly group: string
  readonly icon?: IconName
  readonly detail?: string
  readonly keywords?: string
  readonly onSelect: Message
}

/**
 * Orders items for `query`: an exact prefix of the label first, then a word prefix, then any
 * substring of the label, detail or keywords. An empty query keeps the given order.
 */
export const rankPalette = <Message>(
  input: Readonly<{ items: ReadonlyArray<PaletteItem<Message>>; query: string }>,
): ReadonlyArray<PaletteItem<Message>> => {
  const query = input.query.trim().toLocaleLowerCase()
  if (query.length === 0) return input.items
  const score = (item: PaletteItem<Message>): number => {
    const label = item.label.toLocaleLowerCase()
    if (label.startsWith(query)) return 3
    if (label.split(/[\s/._-]+/u).some((word) => word.startsWith(query))) return 2
    const haystack = `${label} ${item.detail ?? ""} ${item.keywords ?? ""}`.toLocaleLowerCase()
    return haystack.includes(query) ? 1 : 0
  }
  return input.items
    .map((item, index) => ({ item, index, score: score(item) }))
    .filter((entry) => entry.score > 0)
    .toSorted((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.item)
}

/** The palette's state and the Messages its keyboard and pointer interactions send. */
export type CommandPaletteConfig<Message> = SlotConfig<Message> &
  Readonly<{
    id: string
    open: boolean
    query: string
    items: ReadonlyArray<PaletteItem<Message>>
    activeId: string | undefined
    onQuery: (query: string) => Message
    onMove: (step: 1 | -1) => Message
    onHighlight: (id: string) => Message
    onChoose: Message
    onClose: Message
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: CommandPaletteConfig<Message>): Html => {
  const listId = `${config.id}-list`
  const optionId = (item: PaletteItem<Message>) => `${config.id}-option-${item.id}`
  const active = config.items.find((item) => item.id === config.activeId)
  const groups = [...new Set(config.items.map((item) => item.group))]
  return dialog(h, {
    id: config.id,
    open: config.open,
    title: "Command palette",
    onClose: config.onClose,
    variant: "palette",
    children: [
      h.div(
        [...styleAttributes(h, styles.search)],
        [
          icon(h, { name: "search" }),
          h.input([
            h.Id(`${config.id}-input`),
            h.Type("text"),
            h.Value(config.query),
            h.Placeholder("Search pages, actors and actions"),
            h.Role("combobox"),
            h.AriaExpanded(true),
            h.AriaControls(listId),
            h.AriaAutocomplete("list"),
            ...(active === undefined ? [] : [h.AriaActiveDescendant(optionId(active))]),
            h.Autocomplete("off"),
            h.Spellcheck(false),
            h.OnInput(config.onQuery),
            h.OnKeyDownPreventDefault((key) =>
              Match.value(key).pipe(
                Match.when("ArrowDown", () => Option.some(config.onMove(1))),
                Match.when("ArrowUp", () => Option.some(config.onMove(-1))),
                Match.when("Enter", () => Option.some(config.onChoose)),
                Match.orElse(() => Option.none()),
              ),
            ),
            ...styleAttributes(h, styles.input),
          ]),
          kbd(h, { keys: ["esc"] }),
        ],
      ),
      h.div(
        [
          h.Id(listId),
          h.Role("listbox"),
          h.AriaLabel("Commands"),
          ...styleAttributes(h, styles.list),
        ],
        config.items.length === 0
          ? [h.p([...styleAttributes(h, styles.empty)], [`Nothing matches “${config.query}”`])]
          : groups.flatMap((group) => [
              h.div([h.Role("presentation"), ...styleAttributes(h, styles.group)], [group]),
              ...config.items
                .filter((item) => item.group === group)
                .map((item) =>
                  h.keyed("div")(
                    item.id,
                    [
                      h.Id(optionId(item)),
                      h.Role("option"),
                      h.AriaSelected(item.id === config.activeId),
                      h.OnClick(item.onSelect),
                      h.OnMouseEnter(config.onHighlight(item.id)),
                      ...styleAttributes(
                        h,
                        styles.option,
                        item.id === config.activeId && styles.active,
                      ),
                    ],
                    [
                      item.icon === undefined
                        ? h.empty
                        : h.span(
                            [...styleAttributes(h, styles.optionIcon)],
                            [icon(h, { name: item.icon })],
                          ),
                      h.span([...styleAttributes(h, styles.optionLabel)], [item.label]),
                      item.detail === undefined
                        ? h.empty
                        : h.span([...styleAttributes(h, styles.optionDetail)], [item.detail]),
                    ],
                  ),
                ),
            ]),
      ),
      h.div(
        [h.AriaHidden(true), ...styleAttributes(h, styles.foot)],
        [
          h.span([...styleAttributes(h, styles.hint)], [kbd(h, { keys: ["↑", "↓"] }), "Move"]),
          h.span([...styleAttributes(h, styles.hint)], [kbd(h, { keys: ["↵"] }), "Open"]),
          h.span([...styleAttributes(h, styles.hint)], [kbd(h, { keys: ["⌘", "K"] }), "Toggle"]),
        ],
      ),
    ],
  })
}

/** The ⌘K command palette: a search field over grouped, keyboard-navigable results. */
export const commandPalette: {
  <Message>(h: HtmlBuilder<Message>, config: CommandPaletteConfig<Message>): Html
  <Message>(config: CommandPaletteConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
