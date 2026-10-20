import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"

import { scrollRestoreScript } from "./scroll-restore-script.ts"

const key = (path: string): string => `akter:scroll:${path}`

const run = (options: {
  readonly type: string
  readonly stored?: Record<string, string>
  readonly path?: string
  readonly scrollY?: number
  readonly storageThrows?: boolean
}) => {
  const store = new Map(Object.entries(options.stored ?? {}))
  const listeners = new Map<string, () => void>()
  const scrollTo = vi.fn()
  const window = {
    location: { pathname: options.path ?? "/quickstart" },
    performance: { getEntriesByType: () => [{ type: options.type }] },
    sessionStorage: {
      getItem: (name: string) => {
        if (options.storageThrows === true) throw new Error("denied")

        return store.get(name) ?? null
      },
      setItem: (name: string, value: string) => {
        if (options.storageThrows === true) throw new Error("denied")

        store.set(name, value)
      },
    },
    scrollTo,
    history: { scrollRestoration: "auto" },
    scrollY: options.scrollY ?? 0,
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
  }

  runInNewContext(scrollRestoreScript, { window })

  return { store, listeners, scrollTo, history: window.history }
}

describe("scrollRestoreScript", () => {
  it("takes scroll restoration from the browser, so a stale offset it holds cannot override", () => {
    const { history } = run({ type: "navigate" })

    expect(history.scrollRestoration).toBe("manual")
  })

  it("scrolls a reloaded page to the offset saved for its path", () => {
    const { scrollTo } = run({ type: "reload", stored: { [key("/quickstart")]: "1551" } })

    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 1551)
  })

  it("scrolls a page reached by back or forward the same way", () => {
    const { scrollTo } = run({ type: "back_forward", stored: { [key("/quickstart")]: "820" } })

    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 820)
  })

  it("leaves a plain visit at the top even when an offset is saved for the path", () => {
    const { scrollTo } = run({ type: "navigate", stored: { [key("/quickstart")]: "1551" } })

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it("reads only the offset saved for the path it is on", () => {
    const { scrollTo } = run({ type: "reload", stored: { [key("/welcome")]: "300" } })

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it("does not scroll for a missing, zero or unreadable offset", () => {
    for (const stored of [undefined, "0", "", "far"]) {
      const { scrollTo } = run({
        type: "reload",
        stored: stored === undefined ? {} : { [key("/quickstart")]: stored },
      })

      expect(scrollTo).not.toHaveBeenCalled()
    }
  })

  it("saves the offset under the path when the page is hidden", () => {
    const { store, listeners } = run({ type: "navigate", path: "/guides/deploy", scrollY: 1234 })

    listeners.get("pagehide")?.()

    expect(store.get(key("/guides/deploy"))).toBe("1234")
  })

  it("does nothing, and does not throw, where storage refuses", () => {
    const { listeners, scrollTo } = run({ type: "reload", storageThrows: true })

    expect(() => listeners.get("pagehide")?.()).not.toThrow()
    expect(scrollTo).not.toHaveBeenCalled()
  })
})
