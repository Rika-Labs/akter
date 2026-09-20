import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const inventory = JSON.parse(readFileSync(join(root, "research/effect-rule-inventory.json"), "utf8"))
if (!inventory.documentedInventoryComplete || !inventory.pluginNameFoundInSource) {
  console.error("Effect rule/config inventory is not fully verified for the selected toolchain. See research/effect-rule-inventory.json and docs/OPEN_QUESTIONS.md.")
  process.exit(1)
}
const project = process.argv[2] ?? "tsconfig.check.json"
const result = spawnSync("bun", ["x", "--no-install", "@effect/tsgo", "diagnostics", "--project", project], { cwd: root, encoding: "utf8" })
mkdirSync(join(root, ".validation"), { recursive: true })
writeFileSync(join(root, ".validation", project.includes("sentinel") ? "effect-sentinel.log" : "effect-diagnostics.log"), `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error ?? ""}`)
process.stdout.write(result.stdout ?? "")
process.stderr.write(result.stderr ?? "")
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
