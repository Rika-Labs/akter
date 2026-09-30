import {
  type FeedEntry,
  type FeedOptions,
  type Failure,
  RetentionGap,
} from "@durable-actors/core/client"
import { Schema } from "effect"
import { useEffect, useState } from "react"
import { followCreated } from "./created.ts"

/** Anything with an event feed: an `X.client(...).get(id)` handle. */
export interface FeedSource<E extends { readonly Type: unknown }> {
  readonly events: (event: E, options?: FeedOptions) => AsyncIterable<FeedEntry<E["Type"]>>
}

/** Options for `useEventFeed`. */
export interface EventFeedOptions {
  /** Resume after this cursor when nothing is stored under `storageKey`. */
  readonly after?: string
  /**
   * Stores the last delivered cursor in `sessionStorage` under this key, so a
   * reload resumes after it instead of reading the feed again.
   */
  readonly storageKey?: string
}

/** Entries delivered by `useEventFeed` and how it stands. */
export interface EventFeed<Event> {
  /** Entries delivered since this component mounted, in cursor order. */
  readonly entries: ReadonlyArray<FeedEntry<Event>>
  /** The last delivered cursor: resume after it. */
  readonly cursor: string | undefined
  /** How the feed ended, if it did. */
  readonly error: Failure | undefined
  /** Events after the cursor were pruned: reload state instead of resuming. */
  readonly gap: boolean
}

const stored = (key: string | undefined) =>
  key === undefined || !("sessionStorage" in globalThis)
    ? undefined
    : (globalThis.sessionStorage.getItem(key) ?? undefined)

/**
 * Follows an actor's committed `event`s: entries as they commit, reopening
 * after the last cursor whenever the connection drops. With `storageKey` the
 * cursor survives a reload. A pruned gap is surfaced as `gap`, never skipped.
 * An actor no command has created yet is asked for again until one does.
 * Nothing runs on the server during rendering, so it is safe under SSR.
 * `error` is the Promise client's: a declared error or an `ActorError`.
 */
export const useEventFeed = <E extends { readonly Type: unknown }>(
  handle: FeedSource<E>,
  event: E,
  options: EventFeedOptions = {},
): EventFeed<E["Type"]> => {
  const { after, storageKey } = options

  const [feed, setFeed] = useState<EventFeed<E["Type"]>>({
    entries: [],
    cursor: undefined,
    error: undefined,
    gap: false,
  })

  useEffect(() => {
    const controller = new AbortController()
    const from = stored(storageKey) ?? after

    setFeed({ entries: [], cursor: from, error: undefined, gap: false })

    void followCreated(controller.signal, async () => {
      for await (const entry of handle.events(event, { after: from, signal: controller.signal })) {
        if (storageKey !== undefined) globalThis.sessionStorage.setItem(storageKey, entry.cursor)

        setFeed((current) => ({
          ...current,
          entries: [...current.entries, entry],
          cursor: entry.cursor,
        }))
      }
    }).then((error) => {
      if (error !== undefined)
        setFeed((current) => ({ ...current, error, gap: Schema.is(RetentionGap)(error) }))
    })

    return () => controller.abort()
  }, [handle, event, after, storageKey])

  return feed
}
