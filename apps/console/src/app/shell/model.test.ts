import { expect, it } from "vitest"
import { withoutPasswords } from "./model.ts"

it("drops every typed password field and keeps the rest", () => {
  expect(
    withoutPasswords({
      email: "ada@acme.dev",
      password: "hunter2",
      "new-password": "hunter3",
      "confirm-password": "hunter3",
      "org-name": "Acme",
    }),
  ).toEqual({ email: "ada@acme.dev", "org-name": "Acme" })
})
