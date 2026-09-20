import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const graph = JSON.parse(readFileSync(resolve(root, "specs/package-graph.json"), "utf8"))
const blocked = []
for (const name of Object.keys(graph)) {
  const pkg = JSON.parse(readFileSync(resolve(root, "packages", name.split("/").at(-1), "package.json"), "utf8"))
  if (pkg.private || pkg.license === "UNLICENSED") blocked.push(name)
}
if (blocked.length) {
  console.error("Publication intentionally blocked for setup-only/unlicensed packages:", blocked.join(", "))
  console.error("Complete docs/RELEASES.md and the runtime/security gates before enabling publication.")
  process.exitCode = 1
}
