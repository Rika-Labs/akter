import { posix } from "node:path"

import { repositoryLink } from "./site.ts"

/** What the link rewriter needs to know about the repository and the published site. */
export interface LinkEnvironment {
  readonly routes: ReadonlySet<string>
  readonly kind: (repositoryPath: string) => "file" | "directory" | undefined
  readonly anchors: (slug: string) => ReadonlySet<string> | undefined
}

/** A link's final destination, or the reason it is dead. */
export type LinkResolution = { readonly href: string } | { readonly problem: string }

const SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

const withAnchor = (input: {
  readonly environment: LinkEnvironment
  readonly slug: string
  readonly href: string
  readonly fragment: string
}): LinkResolution => {
  if (input.fragment === "") return { href: input.href }

  const anchors = input.environment.anchors(input.slug)

  if (anchors === undefined || anchors.has(input.fragment)) return { href: input.href }

  return { problem: `#${input.fragment} is not a heading of ${input.slug}` }
}

/**
 * Resolves one link written in a published page. Links between published pages become
 * site routes, links to other repository files become GitHub URLs, and anything that
 * points at nothing is reported. `source` is the slug of the page that holds the link.
 */
export const resolveLink = (input: {
  readonly environment: LinkEnvironment
  readonly source: string
  readonly href: string
}): LinkResolution => {
  const { environment, source, href } = input

  if (SCHEME.test(href)) return { href }

  const hashAt = href.indexOf("#")
  const path = hashAt === -1 ? href : href.slice(0, hashAt)
  const fragment = hashAt === -1 ? "" : href.slice(hashAt + 1)

  if (path === "") return withAnchor({ environment, slug: source, href, fragment })

  if (path.startsWith("/")) {
    const slug = path.replace(/^\/+|\/+$/g, "")

    if (!environment.routes.has(slug)) return { problem: `${path} is not a published page` }

    return withAnchor({
      environment,
      slug,
      href: `/${slug}${fragment === "" ? "" : `#${fragment}`}`,
      fragment,
    })
  }

  const target = posix.normalize(posix.join(posix.dirname(`docs/${source}.md`), path))

  if (target.startsWith("..")) return { problem: `${path} leaves the repository` }

  const slug =
    target.startsWith("docs/") && target.endsWith(".md") ? target.slice(5, -3) : undefined

  if (slug !== undefined && environment.routes.has(slug))
    return withAnchor({
      environment,
      slug,
      href: `/${slug}${fragment === "" ? "" : `#${fragment}`}`,
      fragment,
    })

  const kind = environment.kind(target.replace(/\/$/, ""))

  if (kind === undefined) return { problem: `${path} does not exist (${target})` }

  return {
    href: `${repositoryLink({ path: target.replace(/\/$/, ""), directory: kind === "directory" })}${fragment === "" ? "" : `#${fragment}`}`,
  }
}
