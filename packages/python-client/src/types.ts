import { Predicate, Schema } from "effect"

/** The parts of a JSON Schema an OpenAPI document from a served application uses. */
export interface SchemaNode {
  readonly $ref?: string
  readonly type?: string | ReadonlyArray<string>
  readonly enum?: ReadonlyArray<Schema.Json>
  readonly const?: Schema.Json
  readonly anyOf?: ReadonlyArray<SchemaNode>
  readonly oneOf?: ReadonlyArray<SchemaNode>
  readonly items?: SchemaNode
  readonly properties?: Readonly<Record<string, SchemaNode>>
  readonly required?: ReadonlyArray<string>
  readonly additionalProperties?: boolean | SchemaNode
}

const node: Schema.Codec<SchemaNode> = Schema.Struct({
  $ref: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  enum: Schema.optionalKey(Schema.Array(Schema.Json)),
  const: Schema.optionalKey(Schema.Json),
  anyOf: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<SchemaNode> => node))),
  oneOf: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<SchemaNode> => node))),
  items: Schema.optionalKey(Schema.suspend((): Schema.Codec<SchemaNode> => node)),
  properties: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.suspend((): Schema.Codec<SchemaNode> => node),
    ),
  ),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  additionalProperties: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.suspend((): Schema.Codec<SchemaNode> => node)]),
  ),
})

export { node as SchemaNode }

const COMPONENT_PREFIX = "#/components/schemas/"

const RESERVED = new Set(["Any", "Dict", "List", "Literal", "Optional", "TypedDict", "Union"])

/** A Python class name for a schema or component name: `Room.Presence.params` is `RoomPresenceParams`. */
export const className = (name: string) => {
  const joined = name
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== "")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("")

  const safe = /^[0-9]/.test(joined) ? `T${joined}` : joined

  return RESERVED.has(safe) ? `${safe}_` : safe
}

const ESCAPES = new Map([
  ["\\", "\\\\"],
  ['"', '\\"'],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
])

/** A Python string literal for `value`. */
export const pyString = (value: string) =>
  `"${value.replace(/[\\"\p{Cc}]/gu, (char) => ESCAPES.get(char) ?? `\\x${(char.codePointAt(0) ?? 0).toString(16).padStart(2, "0")}`)}"`

/** A Python literal type argument for a JSON constant, or undefined when Python has none. */
const literal = (value: Schema.Json): string | undefined => {
  if (value === null) return "None"

  if (value === true) return "True"

  if (value === false) return "False"

  if (Predicate.isString(value)) return pyString(value)

  return Predicate.isNumber(value) ? String(value) : undefined
}

const literalType = (values: ReadonlyArray<Schema.Json>) => {
  const literals = values.map(literal)

  return literals.every(Predicate.isString) ? `Literal[${literals.join(", ")}]` : "Any"
}

/**
 * Translates the schemas of one served document into Python type expressions
 * and the `TypedDict` declarations they name. A wire value stays the JSON
 * value the server sent, so a `TypedDict` only types it. Named types appear in
 * quotes, which Python resolves lazily, so declarations may be in any order.
 */
export const pythonTypes = (components: Readonly<Record<string, SchemaNode>>) => {
  const declarations = new Map<string, string>()
  const origins = new Map<string, string>()

  const declare = (origin: string, hint: string, build: (name: string) => string) => {
    let name = className(hint)

    for (
      let suffix = 2;
      origins.get(name) !== undefined && origins.get(name) !== origin;
      suffix += 1
    )
      name = `${className(hint)}${suffix}`

    if (origins.get(name) === undefined) {
      origins.set(name, origin)
      declarations.set(name, build(name))
    }

    return `"${name}"`
  }

  const typeOf = (schema: SchemaNode, hint: string): string => {
    if (schema.$ref !== undefined) {
      const name = schema.$ref.slice(COMPONENT_PREFIX.length)
      const target = components[name]

      return declare(`component:${name}`, name, (declared) =>
        target === undefined ? `${declared} = Any` : definition(declared, target),
      )
    }

    if (schema.const !== undefined) return literalType([schema.const])

    if (schema.enum !== undefined) return literalType(schema.enum)

    const alternatives = schema.anyOf ?? schema.oneOf

    if (alternatives !== undefined)
      return union(
        alternatives.map((alternative, index) => typeOf(alternative, `${hint}${index + 1}`)),
      )

    if (Array.isArray(schema.type))
      return union(schema.type.map((type) => typeOf(Object.assign({}, schema, { type }), hint)))

    switch (schema.type) {
      case "string":
        return "str"
      case "integer":
        return "int"
      case "number":
        return "float"
      case "boolean":
        return "bool"
      case "null":
        return "None"
      case "array":
        return `List[${schema.items === undefined ? "Any" : typeOf(schema.items, `${hint}Item`)}]`
      case "object":
        return objectType(schema, hint)
      default:
        return "Any"
    }
  }

  const union = (members: ReadonlyArray<string>) => {
    const distinct = [...new Set(members)]

    return distinct.length === 1 ? distinct[0]! : `Union[${distinct.join(", ")}]`
  }

  const objectType = (schema: SchemaNode, hint: string) => {
    if (schema.properties !== undefined)
      return declare(`inline:${hint}`, hint, (name) => definition(name, schema))

    if (
      schema.additionalProperties === undefined ||
      Predicate.isBoolean(schema.additionalProperties)
    )
      return "Dict[str, Any]"

    return `Dict[str, ${typeOf(schema.additionalProperties, `${hint}Value`)}]`
  }

  const definition = (name: string, schema: SchemaNode): string => {
    if (schema.type !== "object" || schema.properties === undefined)
      return `${name} = ${typeOf(schema, name)}`

    const required = new Set(schema.required ?? [])
    const fields = Object.entries(schema.properties)

    const entries = (keep: (key: string) => boolean) =>
      fields
        .filter(([key]) => keep(key))
        .map(([key, value]) => `${pyString(key)}: ${typeOf(value, `${name}${className(key)}`)}`)
        .join(", ")

    const requiredFields = entries((key) => required.has(key))
    const optionalFields = entries((key) => !required.has(key))

    if (optionalFields === "") return `${name} = TypedDict("${name}", {${requiredFields}})`

    if (requiredFields === "")
      return `${name} = TypedDict("${name}", {${optionalFields}}, total=False)`

    return [
      `_${name}Required = TypedDict("_${name}Required", {${requiredFields}})`,
      `_${name}Optional = TypedDict("_${name}Optional", {${optionalFields}}, total=False)`,
      `class ${name}(_${name}Required, _${name}Optional):`,
      "    pass",
    ].join("\n")
  }

  return {
    typeOf,
    /** Every declaration the types requested so far need, in name order. */
    declarations: () =>
      [...declarations.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, source]) => source),
    /** The public names declared so far. */
    names: () => [...declarations.keys()].sort(),
  }
}
