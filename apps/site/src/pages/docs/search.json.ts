import type { APIRoute } from "astro"
import { loadDocs } from "../../docs/collection.ts"

export const GET: APIRoute = async () => {
  const docs = await loadDocs()
  const entries = docs.pages.flatMap((page) => [
    {
      title: page.title,
      group: page.group,
      url: page.url,
      id: "",
      heading: page.title,
      text: page.description,
    },
    ...page.sections.map((section) => ({
      title: page.title,
      group: page.group,
      url: page.url,
      id: section.id,
      heading: section.heading,
      text: section.text,
    })),
  ])

  return new Response(JSON.stringify(entries), { headers: { "content-type": "application/json" } })
}
