import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { scrollRestoreScript } from "./scroll-restore-script.ts"

const run = (input: {
  readonly navigation: string
  readonly stored?: string
  readonly history?: { scrollRestoration?: string }
}) => {
  const scrolls: Array<[number, number]> = []
  const stored = new Map<string, string>()
  const listeners: Array<() => void> = []
  const frames: Array<() => void> = []
  const fake = {
    location: { pathname: "/quickstart" },
    history: input.history ?? { scrollRestoration: "auto" },
    performance: { getEntriesByType: () => [{ type: input.navigation }] },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    },
    scrollY: 0,
    scrollTo: (x: number, y: number) => void scrolls.push([x, y]),
    addEventListener: (_type: string, listener: () => void) => void listeners.push(listener),
    requestAnimationFrame: (frame: () => void) => void frames.push(frame),
  }

  if (input.stored !== undefined) stored.set("akter:scroll:/quickstart", input.stored)

  runInNewContext(scrollRestoreScript, { window: fake })

  return { fake, scrolls, stored, listeners, frames }
}

describe("scrollRestoreScript", () => {
  it("takes scroll restoration from the browser, so there is one restorer", () => {
    const { fake } = run({ navigation: "reload", stored: "1589" })

    expect(fake.history.scrollRestoration).toBe("manual")
  })

  it("still restores the saved position in a browser without the history setting", () => {
    expect(run({ navigation: "reload", stored: "320", history: {} }).scrolls).toEqual([[0, 320]])
  })

  it("scrolls a reloaded page to the saved position before anything paints", () => {
    expect(run({ navigation: "reload", stored: "1589" }).scrolls).toEqual([[0, 1589]])
  })

  it("scrolls a revisited page to the saved position", () => {
    expect(run({ navigation: "back_forward", stored: "320" }).scrolls).toEqual([[0, 320]])
  })

  it("leaves a plain visit at the top even when an older position is saved", () => {
    expect(run({ navigation: "navigate", stored: "1589" }).scrolls).toEqual([])
  })

  it("does nothing when no position was saved", () => {
    expect(run({ navigation: "reload" }).scrolls).toEqual([])
  })

  it("saves the position of the current path once per frame while scrolling", () => {
    const { fake, stored, listeners, frames } = run({ navigation: "navigate" })

    fake.scrollY = 640
    listeners[0]?.()
    listeners[0]?.()
    expect(frames).toHaveLength(1)

    frames[0]?.()
    expect(stored.get("akter:scroll:/quickstart")).toBe("640")
  })
})
