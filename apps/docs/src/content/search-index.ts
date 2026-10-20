import type { SearchClient } from "fumadocs-core/search/client"
import { staticClient } from "fumadocs-core/search/client/orama-static"

let failures = 0

/**
 * The address of the static search index. The client that reads it keeps the promise of each
 * address it has loaded, a rejected one included, so after a failed load (a dropped
 * connection, a server error) the same address would fail until the page is reloaded. Each
 * failure moves the address on by a query the file host ignores, so the next search loads the
 * index again and a later success is kept.
 */
export const searchIndexAddress = (): string =>
  failures === 0 ? "/search.json" : `/search.json?retry=${failures}`

/**
 * The palette's search client: the static client over the index, narrowed to one section by
 * `tag`, that counts a failed load so the next search starts a fresh one.
 */
export const searchClient = (tag: string | undefined): SearchClient => ({
  deps: [tag],
  search: async (query) => {
    try {
      return await staticClient({ from: searchIndexAddress(), tag }).search(query)
    } catch (error) {
      failures += 1
      throw error
    }
  },
})
