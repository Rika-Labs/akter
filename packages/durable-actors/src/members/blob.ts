declare const BlobTypeId: unique symbol

/**
 * A declared blob: named binary entries each actor of a listing type stores in
 * `actor_blobs`, scoped like every other row the actor owns.
 */
export interface Blob<Name extends string = string> {
  readonly [BlobTypeId]: Name
  readonly name: Name
}

export type AnyBlob = Blob<string>

// Only values made here are blobs, so a look-alike object cannot name another namespace.
const declared = new WeakSet<object>()

export const isBlob = (value: unknown): value is AnyBlob =>
  value instanceof Object && declared.has(value)

/** Declares binary storage an actor lists in `blobs`; the name keys its rows. */
export const blob = <const Name extends string>(name: Name): Blob<Name> => {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(name))
    throw new Error(
      `Blob name ${name} must be 1-80 letters, digits, - or _, starting with a letter`,
    )

  const value = Object.freeze({ name }) as Blob<Name>
  declared.add(value)

  return value
}
