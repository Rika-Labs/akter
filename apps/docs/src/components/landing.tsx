import Link from "next/link"
import { Fragment } from "react"

import type { LandingPage } from "../content/landing-pages.ts"
import { iconOf } from "../content/page-icons.ts"
import { pageOf } from "../content/source.ts"
import { H2 } from "./headings.tsx"
import { PageIcon } from "./icons.tsx"

const anchorOf = (heading: string): string => heading.toLowerCase().replaceAll(" ", "-")

/**
 * A page the app writes itself: a title, one line under it, and groups of cards. Each card
 * names a published page and shows that page's own description.
 */
export function Landing(props: { readonly page: LandingPage }) {
  return (
    <article className="ak-page ak-landing" data-kind="landing">
      <div className="ak-prose">
        <section className="ak-hero">
          <h1 className="ak-hero-title">{props.page.title}</h1>
          <div className="ak-hero-lede">
            <p>{props.page.description}</p>
          </div>
        </section>
        {props.page.sections.map((section) => (
          <Fragment key={section.heading}>
            <H2 id={anchorOf(section.heading)}>{section.heading}</H2>
            <div className="ak-cards" data-cols={section.columns}>
              {section.cards.map((card) => (
                <Link key={card.slug} className="ak-card" href={`/${card.slug}`}>
                  <span className="ak-card-icon">
                    <PageIcon name={iconOf(card.slug)} />
                  </span>
                  <span className="ak-card-title">{card.title}</span>
                  <span className="ak-card-body">
                    <p>{pageOf(card.slug).data.description}</p>
                  </span>
                </Link>
              ))}
            </div>
          </Fragment>
        ))}
      </div>
    </article>
  )
}
