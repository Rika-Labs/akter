import { expect, it } from "vitest"
import { branchPolicy } from "./policy.ts"

it("requires main and issue-linked branches with narrow Dependabot exception", () => {
  expect(() =>
    branchPolicy({ base: "main", branch: "fix/42-login", author: "alice" }),
  ).not.toThrow()
  expect(() => branchPolicy({ base: "dev", branch: "fix/42-login", author: "alice" })).toThrow()
  expect(() =>
    branchPolicy({ base: "main", branch: "dependabot/npm/x", author: "alice" }),
  ).toThrow()
  expect(() =>
    branchPolicy({ base: "main", branch: "dependabot/npm/x", author: "dependabot[bot]" }),
  ).not.toThrow()
})

it("allows release slugs without relaxing ordinary branches or the main-only target", () => {
  expect(() =>
    branchPolicy({ base: "main", branch: "release/launch-npm-ci", author: "alice" }),
  ).not.toThrow()
  for (const branch of ["release/", "release/-launch", "release/launch/extra", "fix/launch-npm-ci"])
    expect(() => branchPolicy({ base: "main", branch, author: "alice" })).toThrow()
  expect(() =>
    branchPolicy({ base: "dev", branch: "release/launch-npm-ci", author: "alice" }),
  ).toThrow("Only main")
})
