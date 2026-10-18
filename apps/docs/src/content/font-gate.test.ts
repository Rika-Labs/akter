import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { fontGateNoScriptStyle, fontGateScript, fontGateStyle } from "./font-gate.ts"

const run = (load: () => Promise<ReadonlyArray<string>>) => {
  const html = {
    gated: true,
    removeAttribute: (name: string) => void (html.gated = name !== "data-font-gate"),
  }
  const timers: Array<() => void> = []

  runInNewContext(fontGateScript, {
    document: { documentElement: html, fonts: { load } },
    setTimeout: (callback: () => void) => void timers.push(callback),
  })

  return { html, timers }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe("fontGateScript", () => {
  it("keeps the page gated until the font has loaded, then lifts the gate", async () => {
    let finish: (value: ReadonlyArray<string>) => void = () => undefined
    const { html } = run(() => new Promise((resolve) => void (finish = resolve)))

    await settle()
    expect(html.gated).toBe(true)

    finish([])
    await settle()
    expect(html.gated).toBe(false)
  })

  it("lifts the gate when the font fails to load", async () => {
    const { html } = run(() => Promise.reject(new Error("network")))

    await settle()
    expect(html.gated).toBe(false)
  })

  it("lifts the gate when the font never settles, after the backstop", () => {
    const { html, timers } = run(() => new Promise(() => undefined))

    expect(html.gated).toBe(true)
    timers[0]?.()
    expect(html.gated).toBe(false)
  })
})

describe("the gate styles", () => {
  it("hide the page only while the attribute is present, and show it without a script", () => {
    expect(fontGateStyle).toBe("html[data-font-gate]{visibility:hidden}")
    expect(fontGateNoScriptStyle).toBe("html[data-font-gate]{visibility:visible}")
  })
})
