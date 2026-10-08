import { expect, it } from "vitest"
import { branchPolicy } from "./policy.ts"

it("requires main and an allowed type prefix with a kebab-case slug, issue number optional", () => {
  for (const branch of ["fix/42-login", "chore/cleanup", "docs/readme-links", "ci/7"])
    expect(() => branchPolicy({ base: "main", branch, author: "alice" })).not.toThrow()

  for (const branch of [
    "main",
    "wip/cleanup",
    "feature/cleanup",
    "fix",
    "fix/",
    "fix/Login",
    "fix/log_in",
    "fix/-login",
    "fix/login-",
    "fix/log--in",
    "fix/a/b",
  ])
    expect(() => branchPolicy({ base: "main", branch, author: "alice" })).toThrow()

  expect(() => branchPolicy({ base: "dev", branch: "fix/42-login", author: "alice" })).toThrow()
  expect(() =>
    branchPolicy({ base: "main", branch: "dependabot/npm/x", author: "alice" }),
  ).toThrow()
  expect(() =>
    branchPolicy({ base: "main", branch: "dependabot/npm/x", author: "dependabot[bot]" }),
  ).not.toThrow()
})
