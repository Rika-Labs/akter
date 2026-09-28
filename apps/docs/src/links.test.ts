import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"

import { type LinkFormat, LinkOutsideRepository, rewriteHref } from "./links.ts"

const published = new Set([
  "guides/README.md",
  "quickstart.md",
  "api/README.md",
  "api/02-context.md",
])

const blob = "https://github.com/Rika-Labs/durable-actors/blob/main"

const rewrite = (source: string, href: string, format: LinkFormat = "html") =>
  rewriteHref({ source, href, format, published })

describe("rewriteHref", () => {
  it.effect("keeps links between published pages relative, in the requested format", () =>
    Effect.gen(function* () {
      expect(yield* rewrite("api/README.md", "02-context.md#turn")).toBe("02-context.html#turn")
      expect(yield* rewrite("api/README.md", "../quickstart.md", "md")).toBe("../quickstart.md")
      expect(yield* rewrite("quickstart.md", "api/02-context.md")).toBe("api/02-context.html")
    }),
  )

  it.effect("maps the home source to the site root's index page", () =>
    Effect.gen(function* () {
      expect(yield* rewrite("api/02-context.md", "../guides/README.md")).toBe("../index.html")
      expect(yield* rewrite("guides/README.md", "../api/README.md")).toBe("api/README.html")
    }),
  )

  it.effect(
    "points unpublished repository paths, including contracts and decisions, at GitHub",
    () =>
      Effect.gen(function* () {
        expect(yield* rewrite("api/02-context.md", "../contracts/02-command-turns.md#order")).toBe(
          `${blob}/docs/contracts/02-command-turns.md#order`,
        )
        expect(yield* rewrite("quickstart.md", "../examples/chat", "md")).toBe(
          `${blob}/examples/chat`,
        )
      }),
  )

  it.effect("leaves anchors and external links alone", () =>
    Effect.gen(function* () {
      for (const href of [
        "#turn",
        "https://effect.website",
        "mailto:a@example.com",
        "//cdn.test/x",
      ])
        expect(yield* rewrite("api/02-context.md", href)).toBe(href)
    }),
  )

  it.effect("rejects a relative link that climbs above the repository root", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(rewrite("api/02-context.md", "../../../secret.md"))

      expect(error).toEqual(
        LinkOutsideRepository.make({ source: "api/02-context.md", href: "../../../secret.md" }),
      )
    }),
  )
})
