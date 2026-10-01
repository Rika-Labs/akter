import { Effect, Predicate, Schema } from "effect"
import { InvalidDocument, type MemberOperation, readDocument } from "./document.ts"
import { className, pyString, pythonTypes, type SchemaNode } from "./types.ts"

/** The generated package's name is not a Python module name. */
export class InvalidPackageName extends Schema.TaggedError<InvalidPackageName>()(
  "InvalidPackageName",
  { name: Schema.String },
) {}

const pyList = (values: ReadonlyArray<string>) =>
  `[${values.map((value) => pyString(value)).join(", ")}]`

const PACKAGE_NAME = /^[a-z][a-z0-9_]*$/

const KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
])

const snake = (name: string) => {
  const lowered = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()

  return KEYWORDS.has(lowered) ? `${lowered}_` : lowered
}

export interface GenerateOptions {
  /** The parsed OpenAPI 3.1 document a served application answers at its `openapi.path`. */
  readonly document: Schema.Json
  /** The generated Python package's name, a lowercase module name. */
  readonly name: string
  /** The source of `runtime.py`, copied verbatim into the package as `_runtime.py`. */
  readonly runtime: string
}

const HEADER = "Generated from a served OpenAPI document by @akter/python-client. Do not edit."

const IMPORTS = "from typing import Any, Dict, List, Literal, Optional, Tuple, TypedDict, Union"

/** The tag a declared error's schema is discriminated by. */
const tagOf = (schema: SchemaNode, components: Readonly<Record<string, SchemaNode>>) => {
  const resolved =
    schema.$ref === undefined
      ? schema
      : components[schema.$ref.slice("#/components/schemas/".length)]

  const tag = resolved?.properties?.["_tag"]?.enum?.[0]

  return Predicate.isString(tag) ? tag : undefined
}

/**
 * Generates a self-contained Python package from a served OpenAPI document:
 * `models.py` types every schema the public members use, `client.py` has one
 * class per actor with one method per public command, reducer, and query,
 * and `_runtime.py` is the fixed runtime that mints command ids and keeps one
 * id across retries. Returns file contents keyed by path under the package.
 */
export const generate = Effect.fnUntraced(function* (options: GenerateOptions) {
  if (!PACKAGE_NAME.test(options.name))
    return yield* InvalidPackageName.make({ name: options.name })

  const document = yield* readDocument(options.document)
  const types = pythonTypes(document.components)
  const actors = new Map<string, Array<MemberOperation>>()

  for (const operation of document.operations)
    actors.set(operation.actor, [...(actors.get(operation.actor) ?? []), operation])

  const declared: Array<string> = []
  const operations: Array<string> = []
  const classes: Array<string> = []
  const attributes: Array<string> = []
  const assignments: Array<string> = []

  for (const [actor, members] of actors) {
    const seen = new Set<string>()
    const methods: Array<string> = []

    for (const operation of members) {
      const method = snake(operation.member)

      if (seen.has(method))
        return yield* InvalidDocument.make({
          reason: `${actor} has two members named ${method} in snake case`,
        })

      seen.add(method)

      const hint = `${actor}${operation.member}`
      const parameters = ["self"]

      if (operation.keyed) parameters.push("id: str")

      if (operation.input !== undefined)
        parameters.push(
          operation.inputRequired
            ? `input: ${types.typeOf(operation.input, `${hint}Input`)}`
            : `input: Optional[${types.typeOf(operation.input, `${hint}Input`)}] = None`,
        )

      parameters.push("/")

      if (operation.command) parameters.push("*", "command_id: Optional[str] = None")

      const output =
        operation.output === undefined ? "None" : types.typeOf(operation.output, `${hint}Output`)

      const tags = operation.declared.flatMap((schema) => {
        types.typeOf(schema, `${hint}Error`)
        const tag = tagOf(schema, document.components)

        return tag === undefined ? [] : [tag]
      })

      if (tags.length > 0) declared.push(`    ${pyString(operation.operationId)}: ${pyList(tags)},`)

      const target = operation.keyed
        ? `_runtime.path(${pyString(operation.path)}, id)`
        : pyString(operation.path)

      const body =
        operation.input === undefined
          ? []
          : [
              operation.inputRequired
                ? "            body=input,"
                : "            body=_runtime.UNSET if input is None else input,",
            ]

      const doc = `${operation.operationId}, a ${operation.command ? "command" : "query"}.${
        tags.length === 0 ? "" : ` Raises DeclaredError with tag ${tags.join(", ")}.`
      }`

      methods.push(
        [
          `    def ${method}(${parameters.join(", ")}) -> ${output}:`,
          `        ${pyString(doc)}`,
          "        return self._runtime.call(",
          `            ${target},`,
          `            command=${operation.command ? "True" : "False"},`,
          ...body,
          ...(operation.command ? ["            command_id=command_id,"] : []),
          "        )",
        ].join("\n"),
      )

      operations.push(
        `    ${pyString(operation.operationId)}: (${pyString(snake(actor))}, ${pyString(method)}),`,
      )
    }

    classes.push(
      [
        `class ${className(actor)}Client:`,
        "    def __init__(self, runtime: _runtime.Runtime) -> None:",
        "        self._runtime = runtime",
        "",
        methods.join("\n\n"),
      ].join("\n"),
    )

    attributes.push(`    ${snake(actor)}: ${className(actor)}Client`)
    assignments.push(`        self.${snake(actor)} = ${className(actor)}Client(self)`)
  }

  const client = [
    `"""${HEADER}"""`,
    "",
    "from __future__ import annotations",
    "",
    IMPORTS,
    "",
    "from . import _runtime",
    "from .models import *",
    "",
    `PROTOCOL_PATH = ${pyString(document.protocolPath)}`,
    "",
    "OPERATIONS: Dict[str, Tuple[str, str]] = {",
    ...operations,
    "}",
    "",
    "DECLARED_ERRORS: Dict[str, List[str]] = {",
    ...declared,
    "}",
    "",
    "",
    classes.join("\n\n\n"),
    "",
    "",
    "class Client(_runtime.Runtime):",
    ...attributes,
    "",
    "    def __init__(self, base_url: str, **options: Any) -> None:",
    "        super().__init__(base_url, protocol_path=PROTOCOL_PATH, **options)",
    ...assignments,
    "",
  ].join("\n")

  const models = [
    `"""${HEADER}"""`,
    "",
    "from __future__ import annotations",
    "",
    IMPORTS,
    "",
    "",
    types.declarations().join("\n\n\n"),
    "",
    `__all__ = [${types
      .names()
      .map((name) => pyString(name))
      .join(", ")}]`,
    "",
  ].join("\n")

  const init = [
    `"""${HEADER}"""`,
    "",
    "from . import models",
    "from ._runtime import *",
    "from .client import DECLARED_ERRORS, OPERATIONS, Client",
    "",
  ].join("\n")

  return {
    [`${options.name}/__init__.py`]: init,
    [`${options.name}/_runtime.py`]: options.runtime,
    [`${options.name}/client.py`]: client,
    [`${options.name}/models.py`]: models,
    [`${options.name}/py.typed`]: "",
  } satisfies Record<string, string>
})
