import { Link as LinkIcon } from "lucide-react"
import type { ComponentProps } from "react"

const WORD_JOINER = "\u2060"

type HeadingTag = "h2" | "h3" | "h4"

/**
 * A heading whose whole text links to its own anchor, with a link icon that shows when the
 * pointer is over the heading. The word joiner keeps the icon from wrapping onto a line of
 * its own.
 */
const anchored = (Tag: HeadingTag) =>
  function Heading({ id, children, ...rest }: ComponentProps<"h2">) {
    return (
      <Tag id={id} {...rest}>
        {id === undefined ? (
          children
        ) : (
          <a href={`#${id}`} className="ak-anchor">
            {children}
            {WORD_JOINER}
            <span className="ak-anchor-icon">
              <LinkIcon aria-hidden="true" />
            </span>
          </a>
        )}
      </Tag>
    )
  }

export const H2 = anchored("h2")

export const H3 = anchored("h3")

export const H4 = anchored("h4")
