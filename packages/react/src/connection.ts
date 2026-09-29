import type {
  ClientConnection,
  ConnectionMessage,
  ConnectOptions,
  Failure,
  ProgressMessage,
  ProgressUpdate,
} from "@durable-actors/core/client"
import { Predicate } from "effect"
import { useCallback, useEffect, useRef, useState } from "react"

/** Anything that opens a connection: a connection member of an `X.client(...).get(id)` handle. */
export interface ConnectionSource<
  Params,
  Server,
  Client,
  Progress extends ProgressUpdate = ProgressUpdate,
> {
  readonly connect: (
    params: Params,
    options?: ConnectOptions,
  ) => Promise<ClientConnection<Server, Client, Progress>>
}

export interface UseConnectionOptions {
  /** Resynchronizes after an owner loss; see the Promise client's `onResync`. */
  readonly onResync?: ConnectOptions["onResync"]
  /** Keeps at most this many recent messages in each of `frames` and `progress`. Default 100. */
  readonly keep?: number
}

export interface Connected<Server, Client, Progress extends ProgressUpdate = ProgressUpdate> {
  readonly status: "connecting" | "open" | "closed"
  /** The most recent frames, oldest first. */
  readonly frames: ReadonlyArray<Server>
  /**
   * The most recent executor progress messages, oldest first: the Promise
   * client's `Progress` messages, whose `frame` narrows by `effect`. Progress is
   * display-only and lossy, and a `seq` gap within one `effectId` and `attempt` is a dropped one.
   */
  readonly progress: ReadonlyArray<ProgressMessage<Progress>>
  /** How the connection ended, if it did; a dropped socket is `SessionEnded` `HolderLost`. */
  readonly error: Failure | undefined
  /** Sends a frame; it rejects once the connection is not open. */
  readonly send: (frame: Client) => Promise<void>
}

const DEFAULT_KEEP = 100

const NOTHING = { frames: [], progress: [] } as const

/** `items` with `item` appended, trimmed to the last `keep`; none when `keep` is zero or less. */
export const keepLast = <Item>(items: ReadonlyArray<Item>, item: Item, keep: number) =>
  keep <= 0 ? [] : [...items, item].slice(-keep)

interface Received<Server, Progress extends ProgressUpdate> {
  readonly frames: ReadonlyArray<Server>
  readonly progress: ReadonlyArray<ProgressMessage<Progress>>
}

/** `received` with `message` filed under `frames` or `progress`; resync notices are for `onResync`. */
export const receive = <Server, Progress extends ProgressUpdate>(
  received: Received<Server, Progress>,
  message: ConnectionMessage<Server, Progress>,
  keep: number,
): Received<Server, Progress> => {
  if (Predicate.isTagged(message, "Frame"))
    return { ...received, frames: keepLast(received.frames, message.frame, keep) }

  if (Predicate.isTagged(message, "Progress"))
    return { ...received, progress: keepLast(received.progress, message, keep) }

  return received
}

/**
 * Holds one connection open while the component is mounted with the same
 * `params` key: the latest frames, `send`, and how it ended. A new key, or
 * unmounting, closes it; a connection is not reopened by itself, because a new
 * one is a new session. Nothing connects during rendering, so it is safe under SSR.
 */
export const useConnection = <Params, Server, Client, Progress extends ProgressUpdate>(
  member: ConnectionSource<Params, Server, Client, Progress>,
  params: Params,
  options: UseConnectionOptions = {},
): Connected<Server, Client, Progress> => {
  const keep = options.keep ?? DEFAULT_KEEP
  const key = JSON.stringify(params ?? null)
  const [status, setStatus] = useState<Connected<Server, Client, Progress>["status"]>("connecting")
  const [received, setReceived] = useState<Received<Server, Progress>>(NOTHING)
  const [error, setError] = useState<Failure | undefined>(undefined)
  const connection = useRef<ClientConnection<Server, Client, Progress> | undefined>(undefined)
  const onResync = useRef(options.onResync)
  onResync.current = options.onResync

  useEffect(() => {
    const controller = new AbortController()
    let open: ClientConnection<Server, Client, Progress> | undefined

    setStatus("connecting")
    setReceived(NOTHING)
    setError(undefined)

    const run = async () => {
      try {
        open = await member.connect(params, {
          signal: controller.signal,
          onResync: (resync) => onResync.current?.(resync),
        })

        if (controller.signal.aborted) return void open.close()

        connection.current = open
        setStatus("open")

        for await (const message of open.messages)
          setReceived((current) => receive(current, message, keep))

        if (!controller.signal.aborted) setStatus("closed")
      } catch (thrown) {
        if (controller.signal.aborted) return

        // The Promise client rejects only with declared errors and `ActorError`s.
        setError(thrown as Failure)
        setStatus("closed")
      }
    }

    void run()

    return () => {
      controller.abort()
      connection.current = undefined
      void open?.close()
    }
    // `params` is compared by its JSON key, so a new object with the same content keeps the connection.
  }, [member, key, keep])

  const send = useCallback(async (frame: Client) => {
    const current = connection.current

    if (current === undefined) throw new Error("useConnection: the connection is not open")

    return current.send(frame)
  }, [])

  return { status, frames: received.frames, progress: received.progress, error, send }
}
