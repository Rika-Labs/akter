import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { Schema } from "effect"
import { parseSync } from "oxc-parser"
import type { CallExpression, ModuleExportName, Node, Program } from "oxc-parser"

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"]

const isString = Schema.is(Schema.String)

const PARSED = new Map<string, Program | null>()

function unwrap(node: Node | null | undefined): Node | null {
  let current = node ?? null

  while (
    current !== null &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "ParenthesizedExpression")
  ) {
    current = current.expression
  }

  return current
}

/**
 * The string a property key spells, or null when it is
 * computed from something other than a literal.
 */
function keyName(key: Node, computed: boolean): string | null {
  if (key.type === "Identifier") return computed ? null : key.name
  if (key.type === "Literal" && isString(key.value)) return key.value

  return null
}

function moduleName(name: ModuleExportName): string {
  return name.type === "Identifier" ? name.name : String(name.value)
}

function jobKeys(call: CallExpression): ReadonlySet<string> | null {
  const callee = call.callee

  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.object.type !== "Identifier" ||
    callee.object.name !== "Actor" ||
    callee.property.type !== "Identifier" ||
    callee.property.name !== "make"
  )
    return null

  const definition = unwrap(call.arguments[1])

  if (definition === null || definition.type !== "ObjectExpression") return new Set()

  const jobs = new Set<string>()

  for (const member of definition.properties) {
    if (member.type !== "Property" || keyName(member.key, member.computed) !== "jobs") continue

    const table = unwrap(member.value)

    if (table === null || table.type !== "ObjectExpression") continue

    for (const job of table.properties) {
      if (job.type !== "Property") continue

      const name = keyName(job.key, job.computed)

      if (name !== null) jobs.add(name)
    }
  }

  return jobs
}

function contractFromExpression(node: Node | null | undefined): ReadonlySet<string> | null {
  const expression = unwrap(node)

  return expression !== null && expression.type === "CallExpression" ? jobKeys(expression) : null
}

function sourceFile(from: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null

  const base = resolve(dirname(from), specifier)
  const stem = base.replace(/\.[cm]?jsx?$/, "")
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${stem}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => resolve(base, `index${extension}`)),
  ]

  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  )
}

function parseFile(file: string): Program | null {
  const cached = PARSED.get(file)

  if (cached !== undefined) return cached

  const parsed = parseSync(file, readFileSync(file, "utf8"))
  const program = parsed.errors.length === 0 ? parsed.program : null

  PARSED.set(file, program)

  return program
}

function localContract(
  program: Program,
  file: string,
  name: string,
  visited: ReadonlySet<string>,
): ReadonlySet<string> | null {
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement

    if (declaration !== null && declaration.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === "Identifier" && declarator.id.name === name)
          return contractFromExpression(declarator.init)
      }
    }

    if (statement.type !== "ImportDeclaration" || !isString(statement.source.value)) continue

    for (const specifier of statement.specifiers) {
      if (specifier.local.name !== name) continue
      if (specifier.type === "ImportNamespaceSpecifier") return null

      const target = sourceFile(file, statement.source.value)

      return target === null
        ? null
        : exportedContract(
            target,
            specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : moduleName(specifier.imported),
            visited,
          )
    }
  }

  return null
}

function exportedContract(
  file: string,
  name: string,
  visited: ReadonlySet<string>,
): ReadonlySet<string> | null {
  const key = `${file}#${name}`

  if (visited.has(key)) return null

  const seen = new Set(visited).add(key)
  const program = parseFile(file)

  if (program === null) return null

  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration" && name === "default") {
      const declaration = unwrap(statement.declaration)

      if (declaration !== null && declaration.type === "Identifier")
        return localContract(program, file, declaration.name, seen)

      return contractFromExpression(declaration)
    }

    if (statement.type === "ExportNamedDeclaration") {
      if (statement.declaration !== null && statement.declaration.type === "VariableDeclaration") {
        for (const declarator of statement.declaration.declarations) {
          if (declarator.id.type === "Identifier" && declarator.id.name === name)
            return contractFromExpression(declarator.init)
        }

        continue
      }

      for (const specifier of statement.specifiers) {
        if (moduleName(specifier.exported) !== name) continue

        if (statement.source === null)
          return localContract(program, file, moduleName(specifier.local), seen)

        const target = sourceFile(file, String(statement.source.value))

        return target === null ? null : exportedContract(target, moduleName(specifier.local), seen)
      }

      continue
    }

    if (
      statement.type === "ExportAllDeclaration" &&
      statement.exported === null &&
      name !== "default"
    ) {
      const target = sourceFile(file, String(statement.source.value))
      const found = target === null ? null : exportedContract(target, name, seen)

      if (found !== null) return found
    }
  }

  return null
}

/**
 * The names a contract declares under `jobs:` when `receiver` (the source text
 * of the object a `.toLayer({...})` call is made on) resolves to an
 * `Actor.make(...)` call in `text`, the module being linted, or in a module
 * reached through relative imports and re-exports; null when it does not
 * resolve to one.
 */
export function contractJobs(
  file: string,
  text: string,
  receiver: string,
): ReadonlySet<string> | null {
  const parsedReceiver = parseSync("receiver.ts", `(${receiver})`)
  const statement = parsedReceiver.program.body[0]

  if (statement === undefined || statement.type !== "ExpressionStatement") return null

  const target = unwrap(statement.expression)

  if (target === null) return null
  if (target.type === "CallExpression") return jobKeys(target)
  if (target.type !== "Identifier") return null

  const parsed = parseSync(file, text)

  return parsed.errors.length === 0
    ? localContract(parsed.program, file, target.name, new Set())
    : null
}
