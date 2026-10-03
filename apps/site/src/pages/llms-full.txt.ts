import type { APIRoute } from "astro"
import { loadDocs } from "../docs/collection.ts"

export const GET: APIRoute = async () => {
  const docs = await loadDocs()
  const body = docs.pages
    .map((page) => `<!-- ${page.url} -->\n\n${page.markdown}`)
    .join("\n---\n\n")

  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } })
}
