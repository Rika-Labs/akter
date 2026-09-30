import { dual } from "effect/Function"
import type { WriteSet } from "./protocol.ts"

/**
 * What one rerun of a watched query read, as the recorder saw it: whether it
 * touched `state` (all keyed state counts as one), and the event classes,
 * tables, and blobs it named. `group` and `caller` note reads the commit signal
 * cannot cover or that make the result depend on who asked.
 */
export interface ReadSet {
  state: boolean
  readonly events: Set<string>
  readonly tables: Set<string>
  readonly blobs: Set<string>
  group: boolean
  caller: boolean
}

/** A read set that has recorded nothing. */
export const emptyReadSet = (): ReadSet => ({
  state: false,
  events: new Set(),
  tables: new Set(),
  blobs: new Set(),
  group: false,
  caller: false,
})

/** Whether a commit that wrote `writes` may have changed the result of a query that read `reads`. */
export const invalidates: {
  (reads: ReadSet): (writes: WriteSet) => boolean
  (writes: WriteSet, reads: ReadSet): boolean
} = dual(
  2,
  (writes: WriteSet, reads: ReadSet) =>
    (writes.state && reads.state) ||
    writes.events.some((tag) => reads.events.has(tag)) ||
    writes.tables.some((table) => reads.tables.has(table)) ||
    writes.blobs.some((blob) => reads.blobs.has(blob)),
)

/** The read that makes a query unwatchable, named for the refusal; undefined when every read is supported. */
export const unsupportedRead = (reads: ReadSet) =>
  reads.group
    ? "The query reads its placement group, which has no commit signal per actor"
    : undefined
