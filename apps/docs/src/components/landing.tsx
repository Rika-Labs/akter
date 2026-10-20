import Link from "next/link"
import { Fragment } from "react"

import type { LandingCard, LandingPage } from "../content/landing-pages.ts"
import { iconOf } from "../content/page-icons.ts"
import { pageOf } from "../content/source.ts"
import { DocFrame } from "./doc-frame.tsx"
import { H2 } from "./headings.tsx"
import { PageIcon } from "./icons.tsx"

const anchorOf = (heading: string): string => heading.toLowerCase().replaceAll(" ", "-")

function Card(props: { readonly card: LandingCard }) {
  return (
    <Link className="ak-card" href={`/${props.card.slug}`}>
      <span className="ak-card-icon">
        <PageIcon name={iconOf(props.card.slug)} />
      </span>
      <span className="ak-card-title">{props.card.title}</span>
      <span className="ak-card-body">
        <p>{pageOf(props.card.slug).data.description}</p>
      </span>
    </Link>
  )
}

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
                <Card key={card.slug} card={card} />
              ))}
            </div>
          </Fragment>
        ))}
      </div>
    </article>
  )
}

/**
 * A generated page that reads as an article: the document frame with its table of contents
 * and page actions, one line under the title, and a heading with a card for each page of a
 * group.
 */
export function Overview(props: { readonly page: LandingPage }) {
  return (
    <DocFrame
      title={props.page.title}
      slug={props.page.slug}
      toc={props.page.sections.map((section) => ({
        title: section.heading,
        id: anchorOf(section.heading),
        depth: 2,
      }))}
    >
      <p>{props.page.description}</p>
      {props.page.sections.map((section) => (
        <Fragment key={section.heading}>
          <H2 id={anchorOf(section.heading)}>{section.heading}</H2>
          {section.cards.map((card) => (
            <Card key={card.slug} card={card} />
          ))}
        </Fragment>
      ))}
    </DocFrame>
  )
}
