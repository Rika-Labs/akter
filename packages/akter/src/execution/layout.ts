import { Result, Schema } from "effect"
import type { Fields } from "../contract/context.ts"
import { MemberCodec } from "../contract/handle.ts"
import type { AnyActor } from "../contract/make.ts"
import { isList } from "../contract/members.ts"
import type { MemberSchema, OptionalSchema } from "../contract/members.ts"
import { emptyItems, orderingOf } from "../handlers/lists.ts"
import type { Items, Ordering } from "../handlers/lists.ts"

/** A decoded value: state, payloads, list items and replies as handlers see them. */
export type Decoded = any

/**
 * Encodes and decodes one member schema synchronously, because actions are synchronous; a failure
 * throws its `SchemaError`, which the action runner records as a defect.
 */
export interface Codec {
  readonly encode: (value: Decoded) => Schema.Json
  readonly decode: (value: Schema.Json) => Decoded
}

/** One actor instance's state at a point: decoded and encoded scalar fields, and every list. */
export interface Image {
  readonly state: Decoded
  readonly encoded: Readonly<Record<string, Schema.Json>>
  readonly lists: ReadonlyMap<string, Items>
}

/** One state field that is not a list. */
export interface FieldLayout extends Codec {
  readonly optional: boolean
}

/** One list field. */
export interface ListLayout {
  readonly ordering: Ordering
  readonly item: Codec
}

/** Everything the engine derives once from a contract. */
export interface Layout {
  readonly actor: AnyActor
  readonly key: Codec
  readonly fields: ReadonlyMap<string, FieldLayout>
  readonly lists: ReadonlyMap<string, ListLayout>
  readonly initial: Image
  readonly codec: (schema: OptionalSchema) => Codec
}

const nullCodec: Codec = { encode: () => null, decode: () => undefined }

const codecs = new WeakMap<MemberSchema, Codec>()

const codec = (schema: OptionalSchema): Codec => {
  if (schema === undefined) return nullCodec
  const cached = codecs.get(schema)
  if (cached !== undefined) return cached
  const json = MemberCodec.json(schema)
  const encode = Schema.encodeResult(json)
  const decode = Schema.decodeResult(json)
  const made: Codec = {
    encode: (value) => Result.getOrThrow(encode(value)),
    decode: (value) => Result.getOrThrow(decode(value)),
  }
  codecs.set(schema, made)
  return made
}

const layouts = new WeakMap<AnyActor, Layout>()

/**
 * The layout of an actor: codecs for its key, each scalar field and each list's items, and its
 * initial image, the decode of `{}`.
 */
const of = (actor: AnyActor): Layout => {
  const cached = layouts.get(actor)
  if (cached !== undefined) return cached
  const declared: Fields = actor.state.fields
  const fields = new Map<string, FieldLayout>()
  const lists = new Map<string, ListLayout>()
  const scalar: Record<string, MemberSchema> = {}
  for (const [name, field] of Object.entries(declared)) {
    if (isList(field)) {
      lists.set(name, { ordering: orderingOf(field), item: codec(field.item) })
      continue
    }
    scalar[name] = field
    fields.set(name, { ...codec(field), optional: field.ast.context?.isOptional === true })
  }
  const state = codec(Schema.Struct(scalar)).decode({})
  const encoded: Record<string, Schema.Json> = {}
  for (const [name, field] of fields)
    if (Object.hasOwn(state, name) && state[name] !== undefined) encoded[name] = field.encode(state[name])
  const layout: Layout = {
    actor,
    key: codec(actor.key),
    fields,
    lists,
    initial: { state, encoded, lists: new Map(Array.from(lists.keys(), (name) => [name, emptyItems])) },
    codec,
  }
  layouts.set(actor, layout)
  return layout
}

/** Per-actor codecs and initial state. */
export const Layouts = { of, codec }
