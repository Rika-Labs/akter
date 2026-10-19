import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { fontGateScript, fontGateStartScript, fontGateStyle } from "./font-gate.ts"

const run = (load: (face: string) => Promise<ReadonlyArray<string>>) => {
  const html = {
    gated: true,
    removeAttribute: (name: string) => void (html.gated = name !== "data-font-gate"),
  }
  const timers: Array<() => void> = []
  const requested: Array<string> = []

  runInNewContext(fontGateScript, {
    document: {
      documentElement: html,
      fonts: {
        load: (face: string) => {
          requested.push(face)

          return load(face)
        },
      },
    },
    setTimeout: (callback: () => void) => void timers.push(callback),
  })

  return { html, timers, requested }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe("fontGateStartScript", () => {
  it("puts the gate attribute on the root element", () => {
    const attributes = new Map<string, string>()

    runInNewContext(fontGateStartScript, {
      document: {
        documentElement: {
          setAttribute: (name: string, value: string) => void attributes.set(name, value),
        },
      },
    })

    expect([...attributes]).toEqual([["data-font-gate", ""]])
  })

  it("is the only place the gate is set: the layout never renders the attribute", () => {
    const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8")

    expect(layout).not.toContain("data-font-gate")
  })
})

describe("fontGateScript", () => {
  it("asks for both faces, so a page without code still has the code face decoded", () => {
    const { requested } = run(() => new Promise(() => undefined))

    expect(requested).toEqual(["1em Inter", '1em "Geist Mono"'])
  })

  it("keeps the page gated until both faces have loaded, then lifts the gate", async () => {
    const finish: Array<(value: ReadonlyArray<string>) => void> = []
    const { html } = run(
      (): Promise<ReadonlyArray<string>> => new Promise((resolve) => void finish.push(resolve)),
    )

    finish[0]?.([])
    await settle()
    expect(html.gated).toBe(true)

    finish[1]?.([])
    await settle()
    expect(html.gated).toBe(false)
  })

  it("lifts the gate when a face fails to load", async () => {
    const { html } = run(() => Promise.reject(new Error("decode")))

    await settle()
    expect(html.gated).toBe(false)
  })

  it("lifts the gate when a face never settles, after the backstop", () => {
    const { html, timers } = run(() => new Promise(() => undefined))

    expect(html.gated).toBe(true)
    timers[0]?.()
    expect(html.gated).toBe(false)
  })
})

describe("fontGateStyle", () => {
  it("hides the page only while the attribute is present", () => {
    expect(fontGateStyle).toBe("html[data-font-gate]{visibility:hidden}")
  })
})
