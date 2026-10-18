import { Card, Cards } from "fumadocs-ui/components/card"
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/notebook/page"

import { pageOf } from "../content/source.ts"
import { welcomeDescription, welcomeSections, welcomeTitle } from "../content/welcome.ts"

/** The landing page: the first paths into the docs as cards, each described by its own page. */
export function Welcome() {
  return (
    <DocsPage
      toc={[]}
      tableOfContent={{ enabled: false }}
      tableOfContentPopover={{ enabled: false }}
      breadcrumb={{ enabled: false }}
      footer={{ enabled: false }}
    >
      <DocsTitle>{welcomeTitle}</DocsTitle>
      <DocsDescription>{welcomeDescription}</DocsDescription>
      <DocsBody>
        {welcomeSections.map((section) => (
          <section key={section.heading}>
            <h2 id={section.heading.toLowerCase().replaceAll(" ", "-")}>{section.heading}</h2>
            <Cards>
              {section.cards.map((card) => (
                <Card
                  key={card.slug}
                  title={card.title}
                  href={`/${card.slug}`}
                  description={pageOf(card.slug).data.description}
                />
              ))}
            </Cards>
          </section>
        ))}
      </DocsBody>
    </DocsPage>
  )
}
