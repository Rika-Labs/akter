import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { styleNames } from "./measure.mjs"

export function compare(reference, target, acceptance) {
  if (
    typeof acceptance?.state !== "string" ||
    !acceptance.state.trim() ||
    !Array.isArray(acceptance.checks) ||
    !acceptance.checks.length
  )
    throw new Error("Declare a state and at least one check")
  const failures = []
  const contextKeys = [
    "mode",
    "coordinates",
    "width",
    "height",
    "dpr",
    "scale",
    "scrollX",
    "scrollY",
    "visualOffsetX",
    "visualOffsetY",
    "userAgent",
    "colorScheme",
    "reducedMotion",
  ]
  for (const [label, capture] of [
    ["reference", reference],
    ["target", target],
  ]) {
    if (
      capture?.schema !== 1 ||
      typeof capture.state !== "string" ||
      !capture.state.trim() ||
      !capture.context ||
      !capture.regions ||
      !capture.fonts ||
      !Array.isArray(capture.fonts.faces)
    )
      throw new Error(`${label}: invalid capture`)
    for (const key of contextKeys) {
      const value = capture.context[key]
      if (
        [
          "width",
          "height",
          "dpr",
          "scale",
          "scrollX",
          "scrollY",
          "visualOffsetX",
          "visualOffsetY",
        ].includes(key)
          ? !Number.isFinite(value) ||
            (["width", "height", "dpr", "scale"].includes(key) && value <= 0)
          : typeof value !== "string" || !value
      )
        throw new Error(`${label}: invalid ${key}`)
    }
    if (capture.fonts.status !== "loaded") failures.push(`${label}: fonts not settled`)
  }
  if (reference.state !== target.state) failures.push("State IDs differ")
  if (acceptance.state !== reference.state || acceptance.state !== target.state)
    failures.push("Checklist state differs")
  for (const key of contextKeys)
    if (reference.context[key] !== target.context[key]) failures.push(`Context differs: ${key}`)
  for (const check of acceptance.checks) {
    const geometry = ["box.x", "box.y", "box.width", "box.height"].includes(check?.metric)
    const style =
      typeof check?.metric === "string" &&
      check.metric.startsWith("styles.") &&
      styleNames.includes(check.metric.slice(7))
    if (typeof check?.region !== "string" || !check.region || (!geometry && !style))
      throw new Error("Invalid region or unsupported metric; ink is not measured")
    const mapped = Object.hasOwn(check, "reference") || Object.hasOwn(check, "target")
    if (
      geometry
        ? mapped || !Number.isFinite(check.tolerance) || check.tolerance < 0
        : Object.hasOwn(check, "tolerance") ||
          (mapped && (typeof check.reference !== "string" || typeof check.target !== "string"))
    )
      throw new Error("Invalid tolerance or incomplete style mapping")
    const [group, property] = check.metric.split(".")
    const values = []
    for (const [label, capture] of [
      ["reference", reference],
      ["target", target],
    ]) {
      const region = Object.hasOwn(capture.regions, check.region)
        ? capture.regions[check.region]
        : undefined
      const value = region?.[group]?.[property]
      if (
        region?.box &&
        ["x", "y", "width", "height"].some(
          (k) => Object.hasOwn(region.box, k) && !Number.isFinite(region.box[k]),
        )
      )
        throw new Error(`${label}: malformed box for ${check.region}`)
      if (
        region?.visible !== true ||
        !["x", "y", "width", "height"].every((k) => Number.isFinite(region?.box?.[k])) ||
        region.box.width <= 0 ||
        region.box.height <= 0 ||
        (geometry ? !Number.isFinite(value) : typeof value !== "string" || !value)
      )
        failures.push(`${label}: missing or invalid ${check.region}.${check.metric}`)
      values.push(value)
    }
    const matches = geometry
      ? Number.isFinite(values[0]) &&
        Number.isFinite(values[1]) &&
        Math.abs(values[0] - values[1]) <= check.tolerance
      : mapped
        ? values[0] === check.reference && values[1] === check.target
        : values[0] === values[1]
    if (!matches)
      failures.push(
        `${check.region}.${check.metric}: expected ${mapped ? `${check.reference} → ${check.target}` : "agreement"}, got ${values[0]} → ${values[1]}`,
      )
  }
  return {
    verdict: failures.length ? "FAIL" : "MEASUREMENTS_PASS",
    scope: "declared geometry/style checks",
    checks: acceptance.checks.length,
    failures,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5)
    throw new Error("Usage: node compare.mjs reference.json target.json acceptance.json")
  const digest = (value) => createHash("sha256").update(value).digest("hex")
  const readCapture = (path) => {
    if (basename(path) !== "measurement.json")
      throw new Error("Expected a completed capture's measurement.json")
    const manifest = JSON.parse(readFileSync(join(dirname(path), "complete.json"), "utf8"))
    const measurement = readFileSync(path, "utf8")
    if (
      digest(measurement) !== manifest.measurementSha256 ||
      digest(readFileSync(join(dirname(path), "capture.png"))) !== manifest.screenshotSha256
    )
      throw new Error("Capture artifact hashes differ")
    return JSON.parse(measurement)
  }
  const acceptanceText = readFileSync(process.argv[4], "utf8")
  const result = {
    ...compare(
      readCapture(process.argv[2]),
      readCapture(process.argv[3]),
      JSON.parse(acceptanceText),
    ),
    acceptanceSha256: digest(acceptanceText),
  }
  console.log(JSON.stringify(result, null, 2))
  if (result.verdict !== "MEASUREMENTS_PASS") process.exitCode = 1
}
