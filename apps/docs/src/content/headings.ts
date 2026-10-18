import GithubSlugger from "github-slugger"

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/

const FENCE = /^\s*(`{3,}|~{3,})/

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/

/** The Markdown after its leading frontmatter block, if it has one. */
export const stripFrontmatter = (text: string): string => text.replace(FRONTMATTER, "")

/** A heading's visible text: links, code spans and emphasis lose their markers. */
const plainHeading = (raw: string): string =>
  raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|\*|_)(.+?)\1/g, "$2")
    .trim()

const headingsOutsideFences = (text: string): ReadonlyArray<{ level: number; text: string }> => {
  const found: Array<{ level: number; text: string }> = []
  let fence: string | undefined

  for (const line of stripFrontmatter(text).split(/\r?\n/)) {
    const opening = FENCE.exec(line)

    if (opening !== null) {
      const marker = opening[1] ?? ""

      if (fence === undefined) fence = marker
      else if (marker.startsWith(fence[0] ?? "") && marker.length >= fence.length) fence = undefined
      continue
    }

    if (fence !== undefined) continue

    const heading = HEADING.exec(line)

    if (heading !== null)
      found.push({ level: heading[1]?.length ?? 0, text: plainHeading(heading[2] ?? "") })
  }

  return found
}

/** The text of the first level-one heading outside code fences. */
export const firstHeading = (text: string): string | undefined =>
  headingsOutsideFences(text).find((heading) => heading.level === 1)?.text

/** The anchor id of every heading outside code fences, as GitHub and the docs site derive them. */
export const headingAnchors = (text: string): ReadonlySet<string> => {
  const slugger = new GithubSlugger()

  return new Set(headingsOutsideFences(text).map((heading) => slugger.slug(heading.text)))
}
