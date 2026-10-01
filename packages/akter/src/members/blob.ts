import { Predicate } from "effect"

declare const BlobTypeId: unique symbol

declare const ContentTypeId: unique symbol

/**
 * A declared blob: named binary entries each actor of a listing type stores in
 * `actor_blobs`, scoped like every other row the actor owns.
 */
export interface Blob<Name extends string = string> {
  readonly [BlobTypeId]: Name
  readonly kind: "blob"
  readonly name: Name
}

/**
 * Declared content: named references to immutable bytes stored once per
 * tenant. A turn attaches and detaches references; only off-turn reads see bytes.
 */
export interface ContentBlob<Name extends string = string> {
  readonly [ContentTypeId]: Name
  readonly kind: "content"
  readonly name: Name
}

/** Any declared content, whatever its name. */
export type AnyContent = ContentBlob<string>

/** Anything an actor lists in `blobs`: its own mutable bytes or references to shared content. */
export type AnyBlob = Blob<string> | AnyContent

/** Only values made by `blob` and `content` are registered, so a look-alike object cannot name another namespace. */
const declared = new WeakSet<object>()

/** Whether `value` was made by `blob` or `content`. */
export const isBlob = (value: unknown): value is AnyBlob =>
  value instanceof Object && declared.has(value)

/** Whether a declared blob is content. Tolerates a value that is not a blob at all, which the declared-blob check then refuses. */
export const isContent = (value: AnyBlob): value is AnyContent =>
  Predicate.hasProperty(value, "kind") && value.kind === "content"

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/

const declare = <Kind extends "blob" | "content", const Name extends string>(
  kind: Kind,
  name: Name,
) => {
  if (!NAME.test(name))
    throw new Error(
      `Blob name ${name} must be 1-80 letters, digits, - or _, starting with a letter`,
    )

  const value = Object.freeze({ kind, name })
  declared.add(value)

  return value
}

/**
 * `Actor.blob`: declares binary storage an actor lists in `blobs`; the name
 * keys its entries. Throws unless `name` is 1-80 letters, digits, `-` or `_`,
 * starting with a letter.
 *
 * @example
 * const Avatar = Actor.blob("avatar")
 */
export const blob = <const Name extends string>(name: Name): Blob<Name> =>
  declare("blob", name) as Blob<Name>

/**
 * Declares shared content an actor lists in `blobs`; the name keys its
 * references. The name rules are those of `blob`.
 */
export const content = <const Name extends string>(name: Name): ContentBlob<Name> =>
  declare("content", name) as ContentBlob<Name>
