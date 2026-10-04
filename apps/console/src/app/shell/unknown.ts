import { styleAttributes } from "@akter/ui"
import { colors, space } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"

const styles = stylex.create({
  quiet: { color: colors.mutedForeground },
  notice: { marginBlockEnd: space.md },
})

/** How the console writes a value the runtime does not report: never zero, never `null`. */
export const unknown = "—"

/** A nullable value written with `format`, or `—` when the runtime does not report it. */
export const orUnknown =
  <A>(format: (value: A) => string) =>
  (value: A | null): string =>
    value === null ? unknown : format(value)

/**
 * The total of counts that are each reported or not. One unreported count makes the total unknown,
 * since adding the others would understate it; no counts at all total zero.
 */
export const knownTotal = (values: ReadonlyArray<number | null>): number | null =>
  values.reduce<number | null>(
    (sum, value) => (sum === null || value === null ? null : sum + value),
    0,
  )

/** A whole section or chart the runtime does not report, said once and quietly. */
export const unreported: {
  <Message>(h: HtmlBuilder<Message>, sentence: string): Html
  (sentence: string): <Message>(h: HtmlBuilder<Message>) => Html
} = Function.dual(2, <Message>(h: HtmlBuilder<Message>, sentence: string): Html =>
  h.p([...styleAttributes(h, styles.quiet)], [sentence]),
)

/**
 * The one quiet notice for the part of a live page that fell back to sample data. A page that is
 * sample throughout carries the shell's page notice instead, never this one.
 */
export const sampleNotice = <Message>(h: HtmlBuilder<Message>): Html =>
  h.p(
    [
      h.Role("note"),
      h.DataAttribute("slot", "sample-notice"),
      ...styleAttributes(h, styles.quiet, styles.notice),
    ],
    ["Sample data — this part isn’t connected yet."],
  )
