import { readFileSync } from "node:fs"
import { join } from "node:path"

import { docsDirectory } from "../../content/repository.ts"

export const dynamic = "force-static"

/** The favicon, served from the repository's `docs/favicon.svg` so there is one copy. */
export function GET() {
  return new Response(readFileSync(join(docsDirectory, "favicon.svg")), {
    headers: { "Content-Type": "image/svg+xml" },
  })
}
