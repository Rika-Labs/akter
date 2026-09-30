/** A tuple's column values in text form: null for SQL null, undefined for an unchanged TOAST value. */
export type Tuple = ReadonlyArray<string | null | undefined>

/** A relation as the stream last described it. */
export interface Relation {
  readonly id: number
  readonly schema: string
  readonly table: string
  readonly columns: ReadonlyArray<string>
}

/** One decoded pgoutput message the maintainer acts on. */
export type Change =
  | { readonly kind: "relation"; readonly relation: Relation }
  | { readonly kind: "insert"; readonly relation: number; readonly after: Tuple }
  | {
      readonly kind: "update"
      readonly relation: number
      readonly before: Tuple | undefined
      readonly after: Tuple
    }
  | { readonly kind: "delete"; readonly relation: number; readonly before: Tuple }
  | { readonly kind: "truncate"; readonly relations: ReadonlyArray<number> }
  | { readonly kind: "commit"; readonly end: bigint }
  | { readonly kind: "other" }

const text = new TextDecoder()

/**
 * Decodes one message of the pgoutput protocol, version 1, as
 * `pg_logical_slot_peek_binary_changes` returns it. Messages the maintainer
 * never needs (begin, origin, type, logical messages) decode as `other`.
 */
export const decode = (bytes: Uint8Array): Change => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0

  const byte = () => String.fromCharCode(view.getUint8(at++))

  const int8 = () => view.getInt8(at++)

  const int16 = () => {
    const value = view.getInt16(at)
    at += 2

    return value
  }

  const int32 = () => {
    const value = view.getInt32(at)
    at += 4

    return value
  }

  const uint64 = () => {
    const value = view.getBigUint64(at)
    at += 8

    return value
  }

  const string = () => {
    const end = bytes.indexOf(0, at)
    const value = text.decode(bytes.subarray(at, end))
    at = end + 1

    return value
  }

  const tuple = (): Tuple => {
    const count = int16()
    const values: Array<string | null | undefined> = []

    for (let index = 0; index < count; index++) {
      const kind = byte()

      if (kind === "n") values.push(null)
      else if (kind === "u") values.push(undefined)
      else {
        const length = int32()
        values.push(text.decode(bytes.subarray(at, at + length)))
        at += length
      }
    }

    return values
  }

  const tag = byte()

  switch (tag) {
    case "R": {
      const id = int32()
      const schema = string()
      const table = string()
      int8()
      const count = int16()
      const columns: Array<string> = []

      for (let index = 0; index < count; index++) {
        int8()
        columns.push(string())
        int32()
        int32()
      }

      return { kind: "relation", relation: { id, schema, table, columns } }
    }

    case "I": {
      const relation = int32()
      byte()

      return { kind: "insert", relation, after: tuple() }
    }

    case "U": {
      const relation = int32()
      const marker = byte()

      if (marker === "N") return { kind: "update", relation, before: undefined, after: tuple() }

      const before = tuple()
      byte()

      return { kind: "update", relation, before, after: tuple() }
    }

    case "D": {
      const relation = int32()
      byte()

      return { kind: "delete", relation, before: tuple() }
    }

    case "T": {
      const count = int32()
      int8()
      const relations: Array<number> = []

      for (let index = 0; index < count; index++) relations.push(int32())

      return { kind: "truncate", relations }
    }

    case "C": {
      int8()
      uint64()

      return { kind: "commit", end: uint64() }
    }

    default:
      return { kind: "other" }
  }
}
