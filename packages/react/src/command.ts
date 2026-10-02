import {
  ActorError,
  CommandExpired,
  type CommandOptions,
  type Failure,
} from "@rikalabs/akter/client"
import { Schema } from "effect"
import { useCallback, useRef, useState } from "react"

/** Where a command intent stands: not sent, waiting, answered, or failed. */
export type CommandState<Output> =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly commandId: string }
  | { readonly status: "success"; readonly commandId: string; readonly data: Output }
  | {
      readonly status: "error"
      readonly commandId: string
      /** The declared error or `ActorError` the last attempt failed with. */
      readonly error: Failure
      /** The id's retry window passed; `retry` can't help, and a new `run` is a new operation. */
      readonly expired: boolean
    }

/** State of the last intent and the functions that send it. */
export interface UseCommand<Input, Output> {
  readonly state: CommandState<Output>
  /** Sends `input` as a new intent, under a command id minted for it. */
  readonly run: (input: Input) => Promise<Output>
  /** Sends the last intent again under the same command id, so the server runs it at most once. */
  readonly retry: () => Promise<Output>
  /** Forgets the last intent. */
  readonly reset: () => void
}

/** Anything that mints command ids ahead of a call: an `X.client(...)`. */
export interface CommandIds {
  readonly commandId: () => Promise<string>
}

const isExpired = (error: Failure) =>
  Schema.is(ActorError)(error) && Schema.is(CommandExpired)(error.reason)

/**
 * One user intent per command id. `run` mints an id before sending, and
 * `retry` resends the same intent under that id, after a lost response, a
 * timeout, or a refused attempt, so a double click or a retry after a dropped
 * connection replays the receipt instead of running the command twice. An id
 * whose retry window passed is surfaced as `expired`, never replaced. Failures
 * are the Promise client's: declared errors and `ActorError`s.
 */
export const useCommand = <Input, Output>(
  client: CommandIds,
  call: (input: Input, options: CommandOptions) => Promise<Output>,
): UseCommand<Input, Output> => {
  const [state, setState] = useState<CommandState<Output>>({ status: "idle" })

  const intent = useRef<{ readonly input: Input; readonly commandId: string } | undefined>(
    undefined,
  )

  const latest = useRef(call)
  latest.current = call

  const send = useCallback(async () => {
    const current = intent.current

    if (current === undefined) throw new Error("useCommand: no intent to send")

    setState({ status: "pending", commandId: current.commandId })

    try {
      const data = await latest.current(current.input, { commandId: current.commandId })

      if (intent.current === current)
        setState({ status: "success", commandId: current.commandId, data })

      return data
    } catch (thrown) {
      const error = thrown as Failure

      if (intent.current === current)
        setState({
          status: "error",
          commandId: current.commandId,
          error,
          expired: isExpired(error),
        })

      throw error
    }
  }, [])

  const run = useCallback(
    async (input: Input) => {
      intent.current = { input, commandId: await client.commandId() }

      return send()
    },
    [client, send],
  )

  const reset = useCallback(() => {
    intent.current = undefined
    setState({ status: "idle" })
  }, [])

  return { state, run, retry: send, reset }
}
