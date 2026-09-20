import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const target = join(root, "apps/docs/public")
mkdirSync(target, { recursive: true })
cpSync(join(root, "docs"), join(target, "docs"), { recursive: true })
for (const name of ["README.md", "START_HERE.md", "DECISIONS_SUMMARY.md", "RESEARCH_SOURCES.md", "VALIDATION.md"]) {
  if (existsSync(join(root, name))) cpSync(join(root, name), join(target, name))
}
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name)
  return entry.isDirectory() ? walk(path) : [path]
})
const manifest = walk(join(root, "docs")).filter((path) => path.endsWith(".md")).map((path) => ({
  title: readFileSync(path, "utf8").split("\n")[0].replace(/^#\s*/, ""),
  path: `/${relative(root, path).replaceAll("\\", "/")}`,
})).sort((a, b) => a.title.localeCompare(b.title))
writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest, null, 2))
console.log(`Prepared ${manifest.length} documentation files for the Vite setup portal.`)
