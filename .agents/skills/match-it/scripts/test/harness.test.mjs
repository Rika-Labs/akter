import test from "node:test"
import assert from "node:assert/strict"
import { transformedBox, measurementSource } from "../measure.mjs"
import { compare } from "../compare.mjs"

const scope = "declared geometry/style checks"
const state = "welcome/top/light"
const geometry = { state, checks: [{ region: "title", metric: "box.x", tolerance: 0.5 }] }
const family = { state, checks: [{ region: "title", metric: "styles.fontFamily" }] }
const mapped = {
  state,
  checks: [
    {
      region: "title",
      metric: "styles.color",
      reference: "rgb(0, 0, 0)",
      target: "rgb(1, 2, 3)",
    },
  ],
}

function capture() {
  return {
    schema: 1,
    state,
    context: {
      mode: "viewport",
      coordinates: "css-viewport",
      visualOffsetX: 0,
      visualOffsetY: 0,
      width: 1000,
      height: 1000,
      dpr: 2,
      scale: 1,
      scrollX: 0,
      scrollY: 0,
      userAgent: "fixture-browser",
      colorScheme: "light",
      reducedMotion: "no-preference",
    },
    fonts: { status: "loaded", faces: [] },
    regions: {
      title: {
        box: { x: 10, y: 20, width: 30, height: 12 },
        styles: { fontFamily: "Fixture Sans", color: "rgb(0, 0, 0)" },
        visible: true,
      },
    },
  }
}

function verdict(reference, target, checklist, expected) {
  const result = compare(reference, target, checklist)
  assert.equal(result.verdict, expected)
  assert.equal(result.scope, scope)
  assert.ok(Array.isArray(result.failures))
  if (expected === "MEASUREMENTS_PASS") assert.deepEqual(result.failures, [])
  else {
    assert.ok(result.failures.length > 0)
    assert.ok(result.failures.every((value) => typeof value === "string" && value.trim()))
  }
  return result
}

test("geometry tolerance is inclusive and symmetric without rounding", () => {
  for (const [x, expected] of [
    [10, "MEASUREMENTS_PASS"],
    [10.5, "MEASUREMENTS_PASS"],
    [9.5, "MEASUREMENTS_PASS"],
    [10.5001, "FAIL"],
    [9.4999, "FAIL"],
  ]) {
    const target = capture()
    target.regions.title.box.x = x
    verdict(capture(), target, geometry, expected)
  }
})

test("zero tolerance is not replaced by a default", () => {
  const checks = { state, checks: [{ region: "title", metric: "box.x", tolerance: 0 }] }
  verdict(capture(), capture(), checks, "MEASUREMENTS_PASS")
  const target = capture()
  target.regions.title.box.x += 0.000001
  verdict(capture(), target, checks, "FAIL")
})

test("all declared box dimensions are evaluated", () => {
  for (const metric of ["x", "y", "width", "height"]) {
    const target = capture()
    target.regions.title.box[metric] += 2
    verdict(
      capture(),
      target,
      {
        state,
        checks: [{ region: "title", metric: `box.${metric}`, tolerance: 0.5 }],
      },
      "FAIL",
    )
  }
})

test("geometry rejects invalid tolerances and nonfinite observations", () => {
  for (const tolerance of [-0.1, NaN, Infinity, -Infinity, null, "0.5", true]) {
    assert.throws(
      () =>
        compare(capture(), capture(), {
          state,
          checks: [{ region: "title", metric: "box.x", tolerance }],
        }),
      Error,
    )
  }
  for (const x of [NaN, Infinity, -Infinity, null, "10"]) {
    for (const side of ["reference", "target"]) {
      const reference = capture()
      const target = capture()
      ;(side === "reference" ? reference : target).regions.title.box.x = x
      assert.throws(() => compare(reference, target, geometry), Error)
    }
  }
})

test("empty, missing and mixed unknown checks cannot pass", () => {
  for (const checks of [undefined, null, [], {}, [null]]) {
    assert.throws(() => compare(capture(), capture(), { state, checks }), Error)
  }
  for (const metric of ["ink.x", "canvasInk.width", "box.widht", "styles.notAStyle"]) {
    assert.throws(
      () =>
        compare(capture(), capture(), {
          state,
          checks: [...geometry.checks, { region: "title", metric, tolerance: 0.5 }],
        }),
      Error,
    )
  }
})

test("malformed captures throw rather than returning a measurement verdict", () => {
  for (const bad of [null, {}, { ...capture(), schema: 2 }]) {
    assert.throws(() => compare(bad, capture(), geometry), Error)
    assert.throws(() => compare(capture(), bad, geometry), Error)
  }
  const bad = capture()
  delete bad.context.dpr
  assert.throws(() => compare(capture(), bad, geometry), Error)
})

test("missing and hidden requested regions fail on either side", () => {
  for (const side of ["reference", "target"]) {
    for (const change of [
      (value) => {
        delete value.regions.title
      },
      (value) => {
        value.regions.title.visible = false
      },
    ]) {
      const reference = capture()
      const target = capture()
      change(side === "reference" ? reference : target)
      verdict(reference, target, geometry, "FAIL")
    }
  }
})

test("computed fonts must match and a manifest cannot override them", () => {
  verdict(capture(), capture(), family, "MEASUREMENTS_PASS")
  const target = capture()
  target.regions.title.styles.fontFamily = "Wrong Sans"
  target.fonts.faces = [{ family: "Fixture Sans", status: "loaded" }]
  verdict(capture(), target, family, "FAIL")
  delete target.regions.title.styles.fontFamily
  verdict(capture(), target, family, "FAIL")
})

test("style mappings constrain both captured observations", () => {
  const target = capture()
  target.regions.title.styles.color = "rgb(1, 2, 3)"
  verdict(capture(), target, mapped, "MEASUREMENTS_PASS")
  verdict(
    capture(),
    target,
    {
      state,
      checks: [{ region: "title", metric: "styles.color" }],
    },
    "FAIL",
  )
  const wrongReference = capture()
  wrongReference.regions.title.styles.color = "rgb(9, 9, 9)"
  verdict(wrongReference, target, mapped, "FAIL")
  target.regions.title.styles.color = "rgb(9, 9, 9)"
  verdict(capture(), target, mapped, "FAIL")
})

test("one-sided mappings throw", () => {
  for (const key of ["reference", "target"]) {
    const checklist = structuredClone(mapped)
    delete checklist.checks[0][key]
    assert.throws(() => compare(capture(), capture(), checklist), Error)
  }
})

test("acceptance requires an explicit state", () => {
  const checklist = structuredClone(geometry)
  delete checklist.state
  assert.throws(() => compare(capture(), capture(), checklist), Error)
})

test("acceptance state must match both captures, not merely their agreement", () => {
  verdict(
    capture(),
    capture(),
    {
      ...geometry,
      state: "welcome/menu/light",
    },
    "FAIL",
  )
  for (const side of ["reference", "target", "both"]) {
    const reference = capture()
    const target = capture()
    if (side !== "target") reference.state = "welcome/menu/light"
    if (side !== "reference") target.state = "welcome/menu/light"
    verdict(reference, target, geometry, "FAIL")
  }
})

test("capture mode, coordinates and visual offsets are required on both sides", () => {
  for (const key of ["mode", "coordinates", "visualOffsetX", "visualOffsetY"]) {
    for (const side of ["reference", "target", "both"]) {
      const reference = capture()
      const target = capture()
      if (side !== "target") delete reference.context[key]
      if (side !== "reference") delete target.context[key]
      assert.throws(() => compare(reference, target, geometry), Error)
    }
  }
})

test("state, readiness and every declared context mismatch fail", () => {
  const changes = {
    mode: "full-page",
    coordinates: "css-document",
    visualOffsetX: 3,
    visualOffsetY: 7,
    width: 999,
    height: 999,
    dpr: 1,
    scale: 1.25,
    scrollX: 1,
    scrollY: 1,
    userAgent: "other-browser",
    colorScheme: "dark",
    reducedMotion: "reduce",
  }
  for (const [key, value] of Object.entries(changes)) {
    for (const side of ["reference", "target"]) {
      const reference = capture()
      const target = capture()
      ;(side === "reference" ? reference : target).context[key] = value
      verdict(reference, target, geometry, "FAIL")
    }
  }
  const wrongState = capture()
  wrongState.state = "welcome/menu/light"
  verdict(capture(), wrongState, geometry, "FAIL")
  const unready = capture()
  unready.fonts.status = "loading"
  verdict(capture(), unready, geometry, "FAIL")
})

test("one failed check cannot be averaged away by passing checks", () => {
  const target = capture()
  target.regions.title.box.x = 13
  verdict(
    capture(),
    target,
    {
      state,
      checks: [...family.checks, ...geometry.checks],
    },
    "FAIL",
  )
})

test("a tiny shifted control fails despite 99.9992 percent pixel agreement", () => {
  const reference = capture()
  reference.regions.title.box.width = 2
  reference.regions.title.box.height = 2
  const target = structuredClone(reference)
  target.regions.title.box.x += 3
  assert.equal(8 / (1000 * 1000), 0.000008)
  verdict(reference, target, geometry, "FAIL")
})

test("transformed boxes use every corner, including rotation and negative shear", () => {
  const box = { x: 1, y: 2, width: 3, height: 4 }
  for (const [matrix, expected] of [
    [{ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, box],
    [
      { a: 0, b: 1, c: -1, d: 0, e: 10, f: 20 },
      { x: 4, y: 21, width: 4, height: 3 },
    ],
    [
      { a: 1, b: 1, c: -1, d: 1, e: 10, f: 20 },
      { x: 5, y: 23, width: 7, height: 7 },
    ],
    [
      { a: 1, b: 0, c: -2, d: 1, e: 5, f: -3 },
      { x: -6, y: -1, width: 11, height: 4 },
    ],
  ]) {
    assert.deepEqual(transformedBox(box, matrix), expected)
  }
})

test("measurement source is a compilable expression with quoted selector data", () => {
  const source = measurementSource({
    state: "welcome/top/light",
    regions: { title: `[data-label="it's quoted"]` },
  })
  assert.equal(typeof source, "string")
  assert.ok(source.trim())
  assert.doesNotThrow(() => new Function(`return (${source});`))
})
