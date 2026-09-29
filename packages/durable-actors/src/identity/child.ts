const utf8 = new TextEncoder()

const strict = new TextDecoder("utf-8", { fatal: true })

const PREFIX = "c1."

// A decimal byte count with no leading zero. Every `childId` output parses,
// including an empty part: the parent's and child's keys decide validity.
const LENGTH = /^(?:0|[1-9][0-9]{0,9})\./

/**
 * The id of a parent-placed actor: `c1.<byte length of parent>.<parent>.<local>`.
 * The length prefix keeps the form unambiguous when the parent id contains
 * `.` or is itself a child id, so routing never needs a lookup.
 */
export const childId = ({ parent, local }: { readonly parent: string; readonly local: string }) =>
  `${PREFIX}${utf8.encode(parent).byteLength}.${parent}.${local}`

/** Splits a child id into its parent and local parts, or `undefined` when it is not one. */
export const parseChildId = (
  id: string,
): { readonly parent: string; readonly local: string } | undefined => {
  if (!id.startsWith(PREFIX)) return undefined

  const length = LENGTH.exec(id.slice(PREFIX.length))?.[0]

  if (length === undefined) return undefined

  const bytes = utf8.encode(id.slice(PREFIX.length + length.length))
  const size = Number(length.slice(0, -1))

  // The parent must end on a character boundary and be followed by `.`.
  if (bytes.byteLength < size + 1 || bytes[size] !== 0x2e) return undefined

  try {
    const parent = strict.decode(bytes.subarray(0, size))
    const local = strict.decode(bytes.subarray(size + 1))

    return childId({ parent, local }) === id ? { parent, local } : undefined
  } catch {
    return undefined
  }
}
