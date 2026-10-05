import { Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { withDatabase } from "./database.ts"

describe("preview database URL", () => {
  const role = Redacted.make(
    "postgresql://login.abc123:p%40ss%2Fw%3Ard%23@aws.connect.example.test:5432/postgres?sslmode=verify-full",
  )

  it("names the preview's logical database and changes nothing else", () => {
    expect(Redacted.value(withDatabase({ url: role, name: "akter_pr_12" }))).toBe(
      "postgresql://login.abc123:p%40ss%2Fw%3Ard%23@aws.connect.example.test:5432/akter_pr_12?sslmode=verify-full",
    )
  })

  it("keeps a router group in the login and the verification mode in the query", () => {
    const grouped = Redacted.make(
      "postgresql://login.abc123%7Cedge:secret@aws.connect.example.test:5432/postgres?sslmode=verify-full",
    )
    const url = new URL(Redacted.value(withDatabase({ url: grouped, name: "akter_pr_7" })))
    expect(decodeURIComponent(url.username)).toBe("login.abc123|edge")
    expect(url.pathname).toBe("/akter_pr_7")
    expect(url.searchParams.get("sslmode")).toBe("verify-full")
  })

  it("does not alter the URL it was given", () => {
    withDatabase({ url: role, name: "akter_pr_12" })
    expect(Redacted.value(role)).toContain("/postgres?")
  })
})
