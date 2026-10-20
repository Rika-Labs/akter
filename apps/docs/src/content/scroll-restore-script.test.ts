import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"

import { scrollRestoreScript } from "./scroll-restore-script.ts"

const key = (path: string): string => `akter:scroll:${path}`

type Listener = () => void

const run = (options: {
  readonly type: string
  readonly stored?: Record<string, string>
  readonly path?: string
  readonly scrollY?: number
  readonly storageThrows?: boolean
}) => {
  const store = new Map(Object.entries(options.stored ?? {}))
  const listeners = new Map<string, Set<Listener>>()
  const timers: Array<{ readonly run: Listener; readonly delay: number }> = []
  const entries = [{ mode: "auto" }]
  let active = 0
  const history = {
    get scrollRestoration() {
      return entries[active]!.mode
    },
    set scrollRestoration(mode: string) {
      entries[active]!.mode = mode
    },
  }
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
    scrollTo: vi.fn((_x: number, y: number) => {
      window.scrollY = y
    }),
    history,
    scrollY: options.scrollY ?? 0,
    setTimeout: (callback: Listener, delay: number) => timers.push({ run: callback, delay }),
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener)),
    removeEventListener: (type: string, listener: Listener) =>
      listeners.get(type)?.delete(listener),
  }

  runInNewContext(scrollRestoreScript, { window })

  const fire = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener()
  }

  const traverse = () => {
    entries.push({ mode: "auto" })
    active = entries.length - 1
    fire("popstate")
  }

  return { store, window, fire, timers, traverse, entries, scrollTo: window.scrollTo, history }
}

describe("scrollRestoreScript", () => {
  it("scrolls a reloaded page to its saved offset without changing native restoration ownership", () => {
    const { scrollTo, history } = run({ type: "reload", stored: { [key("/quickstart")]: "1551" } })

    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 1551)
    expect(history.scrollRestoration).toBe("auto")
  })

  it("leaves every visit that is not a reload to the browser, so Back keeps its place", () => {
    for (const type of ["navigate", "back_forward", "prerender"]) {
      const { scrollTo, history, window } = run({
        type,
        stored: { [key("/quickstart")]: "1551" },
      })

      expect(scrollTo).not.toHaveBeenCalled()
      expect(history.scrollRestoration).toBe("auto")
      expect(window.scrollY).toBe(0)
    }
  })

  it("reads only the offset saved for the path it is on", () => {
    const { scrollTo, history } = run({ type: "reload", stored: { [key("/welcome")]: "300" } })

    expect(scrollTo).not.toHaveBeenCalled()
    expect(history.scrollRestoration).toBe("auto")
  })

  it("does nothing for a missing, negative, nonfinite or unreadable offset", () => {
    for (const stored of [undefined, "", "far", "-1", "Infinity"]) {
      const { scrollTo, history } = run({
        type: "reload",
        stored: stored === undefined ? {} : { [key("/quickstart")]: stored },
      })

      expect(scrollTo).not.toHaveBeenCalled()
      expect(history.scrollRestoration).toBe("auto")
    }
  })

  it("saves the offset under the path when the page is hidden, on any kind of visit", () => {
    for (const type of ["navigate", "reload", "back_forward"]) {
      const { store, fire, window } = run({ type, path: "/guides/deploy" })

      window.scrollY = 1234
      fire("pagehide")

      expect(store.get(key("/guides/deploy"))).toBe("1234")
    }
  })

  it("saves the current route after client navigation, not the initial document's path", () => {
    const { store, fire, window } = run({ type: "navigate", path: "/welcome" })

    window.location.pathname = "/quickstart"
    window.scrollY = 1360
    fire("pagehide")

    expect(store.get(key("/quickstart"))).toBe("1360")
    expect(store.has(key("/welcome"))).toBe(false)
  })

  it("puts the offset back when a fragment scroll lands elsewhere, and only then", () => {
    const { scrollTo, fire, window } = run({
      type: "reload",
      stored: { [key("/quickstart")]: "1360" },
    })

    fire("scroll")
    expect(scrollTo).toHaveBeenCalledTimes(1)

    window.scrollY = 1210
    fire("scroll")

    expect(scrollTo).toHaveBeenCalledTimes(2)
    expect(scrollTo).toHaveBeenLastCalledWith(0, 1360)
    expect(window.scrollY).toBe(1360)
  })

  it("lets go without changing native restoration when the reader scrolls or touches the page", () => {
    for (const input of ["wheel", "touchstart", "keydown", "mousedown"]) {
      const { scrollTo, fire, window, history } = run({
        type: "reload",
        stored: { [key("/quickstart")]: "1360" },
      })

      fire(input)
      window.scrollY = 1500
      fire("scroll")

      expect(history.scrollRestoration).toBe("auto")
      expect(scrollTo).toHaveBeenCalledTimes(1)
    }
  })

  it("lets go 400 ms after the page has loaded", () => {
    const { scrollTo, fire, timers, window, history } = run({
      type: "reload",
      stored: { [key("/quickstart")]: "1360" },
    })

    fire("load")

    expect(timers).toHaveLength(1)
    expect(timers[0]?.delay).toBe(400)
    expect(history.scrollRestoration).toBe("auto")

    timers[0]?.run()
    window.scrollY = 1210
    fire("scroll")

    expect(history.scrollRestoration).toBe("auto")
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it("restores a saved zero on a hash reload before the browser can expose the anchor", () => {
    const { scrollTo, fire, window } = run({
      type: "reload",
      stored: { [key("/quickstart")]: "0" },
    })

    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0)

    window.scrollY = 1210
    fire("scroll")

    expect(window.scrollY).toBe(0)
  })

  it("ends the reload correction on native history traversal without leaving an entry manual", () => {
    const { scrollTo, fire, traverse, entries, window } = run({
      type: "reload",
      stored: { [key("/quickstart")]: "1000" },
    })

    traverse()
    window.location.pathname = "/welcome"
    window.scrollY = 90
    fire("scroll")

    expect(window.scrollY).toBe(90)
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(entries).toEqual([{ mode: "auto" }, { mode: "auto" }])
  })

  it("never lets a delayed reload release change the new history entry's restoration mode", () => {
    const { fire, timers, traverse, history } = run({
      type: "reload",
      stored: { [key("/quickstart")]: "1000" },
    })

    fire("load")
    traverse()
    history.scrollRestoration = "manual"
    timers[0]?.run()

    expect(history.scrollRestoration).toBe("manual")
  })

  it("releases on a programmatic pathname change without input or popstate", () => {
    const { scrollTo, fire, window, history } = run({
      type: "reload",
      stored: { [key("/quickstart")]: "1360" },
    })

    window.location.pathname = "/welcome"
    window.scrollY = 90
    fire("scroll")

    expect(window.scrollY).toBe(90)
    expect(scrollTo).toHaveBeenCalledTimes(1)

    window.location.pathname = "/quickstart"
    window.scrollY = 700
    fire("scroll")

    expect(window.scrollY).toBe(700)
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(history.scrollRestoration).toBe("auto")
  })

  it("ends the reload correction when the document is left or its hash changes", () => {
    for (const event of ["pagehide", "hashchange"]) {
      const { scrollTo, fire, window } = run({
        type: "reload",
        stored: { [key("/quickstart")]: "1000" },
      })

      fire(event)
      window.scrollY = 90
      fire("scroll")

      expect(window.scrollY).toBe(90)
      expect(scrollTo).toHaveBeenCalledTimes(1)
    }
  })

  it("does nothing, and does not throw, where storage refuses", () => {
    const { fire, scrollTo, history } = run({ type: "reload", storageThrows: true })

    expect(() => fire("pagehide")).not.toThrow()
    expect(scrollTo).not.toHaveBeenCalled()
    expect(history.scrollRestoration).toBe("auto")
  })
})
