import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"))
const graph = readJson("specs/package-graph.json")
const failures = []
const visited = new Set()
const visiting = new Set()
const visit = (name) => {
  if (visiting.has(name)) { failures.push(`Dependency cycle at ${name}`); return }
  if (visited.has(name)) return
  visiting.add(name)
  for (const dependency of graph[name] ?? []) visit(dependency)
  visiting.delete(name)
  visited.add(name)
}
for (const name of Object.keys(graph)) visit(name)
const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name)
  return entry.isDirectory() ? walk(path) : [path]
})
for (const [name, dependencies] of Object.entries(graph)) {
  const short = name.split("/").at(-1)
  const base = join("packages", short)
  const pkg = readJson(join(base, "package.json"))
  if (pkg.name !== name) failures.push(`Name mismatch: ${base}`)
  const actual = Object.keys(pkg.dependencies ?? {}).filter((key) => key in graph).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...dependencies].sort())) failures.push(`Graph mismatch: ${name}`)
  for (const paths of Object.values(pkg.exports ?? {})) {
    for (const target of Object.values(paths)) {
      const source = target.replace("./dist/", "src/").replace(/\.d\.ts$/, ".ts").replace(/\.js$/, ".ts")
      if (!existsSync(join(root, base, source))) failures.push(`Export has no source: ${name} ${target}`)
    }
  }
  if (!existsSync(join(root, base, "test"))) failures.push(`Missing mirrored test directory: ${name}`)
  const files = walk(join(root, base, "src")).filter((path) => path.endsWith(".ts"))
  for (const path of files) {
    const text = readFileSync(path, "utf8")
    if (!name.endsWith("platform-bun") && /from\s+["']bun(?::|["'])|\bBun\./.test(text)) failures.push(`Bun leak: ${path}`)
    if (/from\s+["'][^"']*\.\.\/[^"']*packages\//.test(text)) failures.push(`Cross-package source import: ${path}`)
    for (const match of text.matchAll(/from\s+["'](@durable-actors\/[^/"']+)/g)) {
      if (match[1] !== name && !dependencies.includes(match[1])) failures.push(`Undeclared import ${match[1]} in ${name}`)
    }
  }
}
for (const path of ["README.md", "START_HERE.md", "DECISIONS_SUMMARY.md", "docs/DURABILITY.md", "docs/VALIDATION_GATES.md", "toolchain.lock.json"]) {
  if (!existsSync(join(root, path))) failures.push(`Missing required file: ${path}`)
}
if (failures.length) {
  console.error(failures.join("\n"))
  process.exitCode = 1
} else {
  console.log(`Scaffold graph/exports/source boundaries checked for ${Object.keys(graph).length} packages. No runtime conformance is implied.`)
}
