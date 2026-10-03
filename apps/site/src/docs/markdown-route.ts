import type { APIRoute, GetStaticPaths } from "astro"
import { loadDocs } from "./collection.ts"

/** One static `.md` file per documentation page, for agents that want the page without the chrome. */
export const getStaticPaths = (async () => {
  const docs = await loadDocs()

  return docs.pages.map((page) => ({
    params: { slug: page.slug },
    props: { markdown: page.markdown },
  }))
}) satisfies GetStaticPaths

export const GET: APIRoute = ({ props }) =>
  new Response(String(props["markdown"]), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  })
