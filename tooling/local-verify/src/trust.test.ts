import { expect, it } from "vitest"
import { isTrusted } from "./trust.ts"

const maintainers = ["dallenpyrah"]

it("trusts a named maintainer even from a fork, and a branch in the base repository", () => {
  expect(isTrusted({ author: "DallenPyrah", crossRepository: true }, maintainers)).toBe(true)
  expect(isTrusted({ author: "joe", crossRepository: false }, maintainers)).toBe(true)
})

it("sandboxes a fork from an outside contributor, whatever the branch is called", () => {
  expect(isTrusted({ author: "stranger", crossRepository: true }, maintainers)).toBe(false)
  expect(isTrusted({ author: "dallenpyrah-fan", crossRepository: true }, maintainers)).toBe(false)
})

it("sandboxes bots and unidentifiable authors even on a branch in the base repository", () => {
  expect(isTrusted({ author: "dependabot[bot]", crossRepository: false }, maintainers)).toBe(false)
  expect(isTrusted({ author: "", crossRepository: false }, maintainers)).toBe(false)
})
