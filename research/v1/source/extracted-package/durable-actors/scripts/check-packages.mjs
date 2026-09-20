import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const graph = JSON.parse(readFileSync(resolve(root, "specs/package-graph.json"), "utf8"))
let failed = false
for (const name of Object.keys(graph)) {
  const directory = resolve(root, "packages", name.split("/").at(-1))
  const result = spawnSync("bun", ["x", "--no-install", "publint", directory], { cwd: root, stdio: "inherit" })
  if (result.status !== 0) failed = true
}
console.log("publint checks package structure. Isolated packed-consumer/AreTheTypesWrong release fixtures remain required before publication.")
process.exitCode = failed ? 1 : 0
