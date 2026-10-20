import { describe, expect, it } from "vitest"

import { drawerFocus } from "./drawer.ts"

describe("drawerFocus", () => {
  it("moves focus into the drawer when it opens", () => {
    expect(drawerFocus(false, true)).toBe("enter")
  })

  it("puts focus back on the button when the drawer closes after being open", () => {
    expect(drawerFocus(true, false)).toBe("return")
  })

  it("leaves focus alone when nothing changed, so a load never takes focus", () => {
    expect(drawerFocus(false, false)).toBeUndefined()
    expect(drawerFocus(true, true)).toBeUndefined()
  })
})
