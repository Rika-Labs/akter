import type { ClientConnection, ConnectOptions, Failure } from "@durable-actors/core/client"
import { useCallback, useEffect, useRef, useState } from "react"

/** Anything that opens a connection: a connection member of an `X.client(...).get(id)` handle. */
export interface ConnectionSource<Params, Server, Client> {
  readonly connect: (
    params: Params,
    options?: ConnectOptions,
  ) => Promise<ClientConnection<Server, Client>>
}

export interface UseConnectionOptions {
  /** Resynchronizes after an owner loss; see the Promise client's `onResync`. */
  readonly onResync?: ConnectOptions["onResync"]
  /** Keeps at most this many recent frames in `frames`. Default 100. */
  readonly keep?: number
}

export interface Connected<Server, Client> {
  readonly status: "connecting" | "open" | "closed"
  /** The most recent frames, oldest first. */
  readonly frames: ReadonlyArray<Server>
  /** How the connection ended, if it did; a dropped socket is `SessionEnded` `HolderLost`. */
  readonly error: Failure | undefined
  /** Sends a frame; it rejects once the connection is not open. */
  readonly send: (frame: Client) => Promise<void>
}

const DEFAULT_KEEP = 100

/** `frames` with `frame` appended, trimmed to the last `keep`; none when `keep` is zero or less. */
export const keepLast = <Frame>(frames: ReadonlyArray<Frame>, frame: Frame, keep: number) =>
  keep <= 0 ? [] : [...frames, frame].slice(-keep)

/**
 * Holds one connection open while the component is mounted with the same
 * `params` key: the latest frames, `send`, and how it ended. A new key, or
 * unmounting, closes it; a connection is not reopened by itself, because a new
 * one is a new session. Nothing connects during rendering, so it is safe under SSR.
 */
export const useConnection = <Params, Server, Client>(
  member: ConnectionSource<Params, Server, Client>,
  params: Params,
  options: UseConnectionOptions = {},
): Connected<Server, Client> => {
  const keep = options.keep ?? DEFAULT_KEEP
  const key = JSON.stringify(params ?? null)
  const [status, setStatus] = useState<Connected<Server, Client>["status"]>("connecting")
  const [frames, setFrames] = useState<ReadonlyArray<Server>>([])
  const [error, setError] = useState<Failure | undefined>(undefined)
  const connection = useRef<ClientConnection<Server, Client> | undefined>(undefined)
  const onResync = useRef(options.onResync)
  onResync.current = options.onResync

  useEffect(() => {
    const controller = new AbortController()
    let open: ClientConnection<Server, Client> | undefined

    setStatus("connecting")
    setFrames([])
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

        for await (const frame of open.frames)
          setFrames((current) => keepLast(current, frame, keep))

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

  return { status, frames, error, send }
}
