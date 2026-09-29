import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { describe, expect, it } from "vitest"

import { page, pageRoutes } from "./page.ts"

describe("inspector page", () => {
  it(
    "serves the HTML shell pointing at its API and the bundled client beside it",
    () =>
      Effect.gen(function* () {
        const web = HttpRouter.toWebHandler(Layer.mergeAll(pageRoutes("/_durable/inspector")), {
          disableLogger: true,
        })

        yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))

        const fetch = (path: string) =>
          Effect.gen(function* () {
            const response = yield* Effect.promise(() =>
              web.handler(new Request(`http://localhost${path}`)),
            )

            return {
              status: response.status,
              type: response.headers.get("content-type"),
              cache: response.headers.get("cache-control"),
              body: yield* Effect.promise(() => response.text()),
            }
          })

        const html = yield* fetch("/_durable/inspector")
        expect(html).toMatchObject({
          status: 200,
          type: "text/html; charset=utf-8",
          cache: "no-store",
        })
        expect(html.body).toContain(`data-api="/_durable/inspector/api"`)
        expect(html.body).toContain(`<script type="module" src="/_durable/inspector/client.js">`)

        const script = yield* fetch("/_durable/inspector/client.js")
        expect(script).toMatchObject({ status: 200, type: "text/javascript; charset=utf-8" })

        for (const route of ["/overview", "/actor?", "/dead-letters", "/workflows?status="])
          expect(script.body).toContain(route)
      }).pipe(Effect.scoped, Effect.runPromise),
    30_000,
  )

  it("escapes the paths it writes into the shell", () => {
    const html = page({ api: `/x"><script>`, script: "/c.js" })

    expect(html).toContain(`data-api="/x&quot;&gt;&lt;script&gt;"`)
    expect(html).not.toContain(`"><script>"`)
  })
})
