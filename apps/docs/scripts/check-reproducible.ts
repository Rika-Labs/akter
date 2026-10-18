import { spawn, spawnSync } from "node:child_process"
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { cpus } from "node:os"
import { join, resolve } from "node:path"

import { loadFont } from "../src/hosting/polysans-source.ts"
import { treeDifferences } from "../src/hosting/tree-differences.ts"

const app = resolve(import.meta.dirname, "..")
const scratch = join(app, ".cache", "reproducible")

const build = (name: string): string => {
  for (const directory of [".next", ".source", "out"])
    rmSync(join(app, directory), { recursive: true, force: true })

  const result = spawnSync("bun", ["run", "build"], { cwd: app, stdio: "inherit" })

  if (result.status !== 0) throw new Error(`The ${name} build failed`)

  const copy = join(scratch, name)

  cpSync(join(app, "out"), copy, { recursive: true })

  return copy
}

rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

const pinnedFont = join(scratch, "polysans.woff2")

writeFileSync(pinnedFont, await loadFont())
process.env["POLYSANS_FILE"] = pinnedFont

const calm = build("calm")

const busy = Array.from({ length: cpus().length }, () =>
  spawn("bun", ["-e", "while (true) {}"], { stdio: "ignore" }),
)

const loaded = (() => {
  try {
    return build("loaded")
  } finally {
    for (const child of busy) child.kill()
  }
})()

const differences = treeDifferences(calm, loaded)

if (differences.length > 0) {
  console.error(`Two builds of one commit differ in ${differences.length} files:`)
  for (const difference of differences.slice(0, 40)) console.error(`  ${difference}`)
  process.exit(1)
}

console.log(
  "Two builds of one commit, the second on a fully loaded machine, are byte for byte equal.",
)
