import * as stylex from "@stylexjs/stylex"
import { prose } from "./prose.styles.ts"
import type { ProseClasses } from "./render-html.ts"

const name = (style: stylex.StyleXStyles): string => stylex.props(style).className ?? ""

/** The prose styles resolved to class names, which the Markdown renderer attaches to its output. */
export const proseClasses: ProseClasses = {
  paragraph: name(prose.paragraph),
  h2: name(prose.h2),
  h3: name(prose.h3),
  h4: name(prose.h4),
  step: name(prose.step),
  anchor: name(prose.anchor),
  list: name(prose.list),
  bullets: name(prose.bullets),
  numbers: name(prose.numbers),
  item: name(prose.item),
  link: name(prose.link),
  code: name(prose.code),
  strong: name(prose.strong),
  quote: name(prose.quote),
  rule: name(prose.rule),
  tableWrap: name(prose.tableWrap),
  table: name(prose.table),
  th: name(prose.th),
  td: name(prose.td),
  figure: stylex.props(prose.figure, stylex.defaultMarker()).className ?? "",
  caption: name(prose.caption),
  pre: name(prose.pre),
  codeBlock: name(prose.codeBlock),
  copy: name(prose.copy),
}
