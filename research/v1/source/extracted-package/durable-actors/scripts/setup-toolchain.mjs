import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const inventory = JSON.parse(readFileSync(join(root, "research/effect-rule-inventory.json"), "utf8"))
const issues = []
if (!inventory.documentedInventoryComplete) issues.push("Complete Effect diagnostic inventory is not verified.")
if (!inventory.pluginNameFoundInSource) issues.push("Compiler plugin configuration name was not found in captured official source.")
const result = spawnSync("bun", ["x", "--no-install", "@effect/tsgo", "diagnostics", "--project", "test/diagnostic-sentinel/tsconfig.json"], { cwd: root, encoding: "utf8" })
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error ?? ""}`
if (!/floatingEffect|floating-effect/i.test(output)) issues.push("Intentional floating-Effect diagnostic was not observed.")
if (result.status === 0 || result.status === null) issues.push("Intentional invalid fixture did not fail as required.")
mkdirSync(join(root, ".validation"), { recursive: true })
writeFileSync(join(root, ".validation", "toolchain-setup.json"), JSON.stringify({ rules: inventory.count, issues, exitStatus: result.status, output }, null, 2))
if (issues.length) {
  console.error(issues.join("\n"))
  console.error("Do not disable rules. Verify the pinned @effect/tsgo diagnostics/setup instructions and update this explicit integration.")
  process.exitCode = 1
} else {
  console.log(`Effect diagnostics active; ${inventory.count} inventoried rules configured as errors. Review the inventory on each tool upgrade.`)
}
