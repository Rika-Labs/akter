import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const graph = JSON.parse(readFileSync(resolve(root, "specs/package-graph.json"), "utf8"))
for (const name of Object.keys(graph)) {
  const short = name.split("/").at(-1)
  await import(pathToFileURL(resolve(root, "packages", short, "dist/index.js")).href)
}
console.log(`Loaded ${Object.keys(graph).length} emitted ESM package roots under ${typeof Bun === "undefined" ? "Node" : "Bun"}. This is an import smoke check only.`)
