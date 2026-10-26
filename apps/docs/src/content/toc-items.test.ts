import { describe, expect, it } from "vitest"

import { tocItems } from "./toc-items.ts"

describe("tocItems", () => {
  it("titles each entry by the plain text of its heading and keeps its level", () => {
    expect(
      tocItems(
        [
          { url: "#build-and-boot", depth: 2 },
          { url: "#ready-and-call", depth: 3 },
        ],
        [
          { id: "ready-and-call", content: "Ready and call" },
          { id: "build-and-boot", content: "Build and boot" },
        ],
      ),
    ).toEqual([
      { title: "Build and boot", id: "build-and-boot", depth: 2 },
      { title: "Ready and call", id: "ready-and-call", depth: 3 },
    ])
  })

  it("drops the backticks of inline code but keeps the code and the rest of the heading", () => {
    expect(
      tocItems(
        [{ url: "#akter-login", depth: 3 }],
        [{ id: "akter-login", content: "Sign in with `akter login` and `whoami`" }],
      ),
    ).toEqual([{ title: "Sign in with akter login and whoami", id: "akter-login", depth: 3 }])
  })

  it("shows the anchor of a heading it has no text for", () => {
    expect(tocItems([{ url: "#stop", depth: 2 }], [])).toEqual([
      { title: "stop", id: "stop", depth: 2 },
    ])
  })
})
