import { describe, expect, it } from "vitest"

import { languageLabel, languageOf } from "./code-languages.ts"

describe("languageLabel", () => {
  it("names the languages the pages use by what readers call them", () => {
    expect(languageLabel("ts")).toBe("TypeScript")
    expect(languageLabel("sh")).toBe("Terminal")
    expect(languageLabel("jsonc")).toBe("JSON")
    expect(languageLabel("sql")).toBe("SQL")
    expect(languageLabel("plaintext")).toBe("Text")
  })

  it("shows a fence with no language as text and an unknown language as written", () => {
    expect(languageLabel(undefined)).toBe("Text")
    expect(languageLabel("toml")).toBe("toml")
  })
})

describe("languageOf", () => {
  it("reads the language from a class list that holds other classes", () => {
    expect(languageOf("shiki language-ts")).toBe("ts")
    expect(languageOf("language-sql")).toBe("sql")
  })

  it("is undefined without a language class", () => {
    expect(languageOf(undefined)).toBeUndefined()
    expect(languageOf("shiki")).toBeUndefined()
    expect(languageOf("not-language-ts")).toBeUndefined()
  })
})
