/** A document split into the parts the page lays out separately. */
export interface Prepared {
  readonly title: string
  readonly intro: string
  readonly body: string
}

const GOVERNANCE = /^\*\*Responsibility:\*\*/

const TITLE = /^#\s+(.+)$/

/**
 * Splits a repository document into its title, the paragraph that introduces it, and the rest.
 * The block of Responsibility, Authority, Owner role and Change policy lines that repository
 * documents carry under the title is for maintainers, so it is dropped.
 */
export const prepare = (markdown: string): Prepared => {
  const lines = markdown.split("\n")
  const titleAt = lines.findIndex((line) => TITLE.test(line))
  const title = TITLE.exec(lines[titleAt] ?? "")?.[1]?.trim() ?? "Untitled"
  const rest = lines.slice(titleAt + 1)
  const blocks = rest.join("\n").split(/\n{2,}/)
  const kept = blocks.filter((block) => !GOVERNANCE.test(block.trim()))
  const first = kept[0]?.trim() ?? ""
  const plain = first !== "" && !/^([#>|`]|[-*+]\s|\d+\.\s)/.test(first)

  return {
    title,
    intro: plain ? first.replace(/\s*\n\s*/g, " ") : "",
    body: (plain ? kept.slice(1) : kept).join("\n\n").trim(),
  }
}

/** Reassembles prepared parts into a Markdown document, for the raw Markdown agents fetch. */
export const assemble = (prepared: Prepared): string =>
  [`# ${prepared.title}`, prepared.intro, prepared.body]
    .filter((part) => part !== "")
    .join("\n\n") + "\n"
