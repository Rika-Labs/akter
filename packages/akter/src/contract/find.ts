import { DateTime, Predicate, SchemaAST } from "effect"
import type { Schema } from "effect"
import type { Fields, FindQuery } from "./context.ts"
import type { Bounds } from "./context.ts"
import type { AnyActor } from "./make.ts"
import { isList } from "./members.ts"

/** The scalar representation shared by index pages and peer query results. */
export type IndexValue = string | number | boolean | { readonly bigint: string }

const scalarAst = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isString(ast) ||
  SchemaAST.isNumber(ast) ||
  SchemaAST.isBoolean(ast) ||
  SchemaAST.isBigInt(ast) ||
  SchemaAST.isLiteral(ast) ||
  SchemaAST.isEnum(ast) ||
  SchemaAST.isTemplateLiteral(ast) ||
  SchemaAST.isUndefined(ast) ||
  (SchemaAST.isUnion(ast) && ast.types.every(scalarAst)) ||
  (SchemaAST.isDeclaration(ast) &&
    Predicate.hasProperty(ast.annotations?.representation, "id") &&
    ast.annotations.representation.id === "effect/schema/DateTimeUtc")

export type Scalar = string | number | boolean | bigint | DateTime.DateTime | undefined

/** Indexed schemas are selected from the decoded side, including brands, defaults and optional scalars. */
const field = (actor: AnyActor, name: string) => {
  const fields: Fields = actor.state.fields
  const schema = fields[name]
  return schema === undefined || isList(schema) || !scalarAst(schema.ast) ? undefined : schema
}

const encoder = new TextEncoder()

/** Hex preserves bytewise ordering, including a prefix ending inside a UTF-8 code point. */
const value = (decoded: Scalar): IndexValue | undefined => {
  if (DateTime.isDateTime(decoded)) return DateTime.toEpochMillis(decoded)
  if (Predicate.isBigInt(decoded)) return { bigint: String(decoded) }
  if (Predicate.isNumber(decoded) || Predicate.isBoolean(decoded)) return decoded
  if (!Predicate.isString(decoded)) return undefined
  return Array.from(encoder.encode(decoded).subarray(0, 64), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
}

const primitive = (scalar: IndexValue) =>
  Predicate.isObject(scalar) ? BigInt(scalar.bigint) : scalar

/** Missing optional values sort last in either direction; equal values use ascending encoded ids. */
const compare = (left: IndexValue | undefined, right: IndexValue | undefined): number => {
  if (left === undefined) return right === undefined ? 0 : 1
  if (right === undefined) return -1
  const a = primitive(left)
  const b = primitive(right)
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** One shard's bounded result, with its normalized ordering value for the gateway merge. */
export interface FindRow {
  readonly id: Schema.Json
  readonly order: IndexValue | null
}

const rows = (query: FindQuery<Fields>, found: ReadonlyArray<FindRow>): ReadonlyArray<FindRow> => {
  const direction = query.orderBy?.direction === "desc" ? -1 : 1
  return Array.from(found)
    .sort((a, b) => {
      const order = compare(a.order ?? undefined, b.order ?? undefined)
      if (order !== 0) return a.order === null || b.order === null ? order : order * direction
      const left = JSON.stringify(a.id)
      const right = JSON.stringify(b.id)
      return left === right ? 0 : left < right ? -1 : 1
    })
    .slice(0, query.limit ?? 1_000)
}

/** Equality is either a direct scalar or an explicit `eq`; bounds are conjunctive. */
const matches = (indexed: IndexValue | undefined, condition: Scalar | Bounds<Scalar>): boolean => {
  if (!Predicate.isObject(condition) || DateTime.isDateTime(condition))
    return indexed !== undefined && compare(indexed, value(condition as Scalar)) === 0
  const bounds = condition as Bounds<Scalar>
  if (bounds.eq !== undefined && compare(indexed, value(bounds.eq)) !== 0) return false
  for (const bound of ["gt", "gte", "lt", "lte"] as const) {
    if (bounds[bound] === undefined) continue
    if (indexed === undefined) return false
    const compared = compare(indexed, value(bounds[bound]))
    if (bound === "gt" && compared <= 0) return false
    if (bound === "gte" && compared < 0) return false
    if (bound === "lt" && compared >= 0) return false
    if (bound === "lte" && compared > 0) return false
  }
  return bounds.in === undefined || bounds.in.some((item) => matches(indexed, item))
}

/** Query normalization shared by the browser-safe codec, owner index and peer merge. */
export const Finds = { field, value, compare, rows, matches }
