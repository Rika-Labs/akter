import { Deferred, Effect, Schema } from "effect"

/**
 * A command a client saved before its first attempt. Everything here is plain
 * data, so an adapter can keep it in any structured store; credentials are
 * never part of it, since headers are read again for each attempt. It names
 * the principal it was queued under, so it is never sent as anyone else.
 */
export interface QueuedCommand {
  /** The id minted once for this command; every attempt, in any session, sends it unchanged. */
  readonly commandId: string
  /** Position in the queue; commands of one actor are delivered in this order. */
  readonly sequence: number
  /** The client's `baseUrl`; a client delivers only the commands saved under its own. */
  readonly baseUrl: string
  /**
   * Who queued the command: the client's `identity`, never a credential. A
   * client delivers only the commands saved under the principal it runs as.
   */
  readonly principal: string
  /** The actor's route under `baseUrl`, such as `/actors/Room/r1`. */
  readonly target: string
  /** The member's name. */
  readonly member: string
  /** The JSON text every attempt sends, encoded once when the command was called. */
  readonly body: string | undefined
  /**
   * `queued` until an answer settles it. `expired` means the id's window
   * passed before an answer arrived and `failed` that the server answered with
   * a terminal failure; both stay saved until the application discards them.
   */
  readonly status: "queued" | "expired" | "failed"
  /** The server's terminal answer to a `failed` command, kept so a later session can decode it. */
  readonly answer: { readonly status: number; readonly text: string } | undefined
}

/**
 * Where queued commands survive a reload. `save` resolves only once the
 * command is durable, because a client sends nothing before then.
 */
export interface OfflineStore {
  /** Every saved command, in the order they were queued. */
  readonly entries: () => Promise<ReadonlyArray<QueuedCommand>>
  /** Saves `command`, replacing the one with the same id. */
  readonly save: (command: QueuedCommand) => Promise<void>
  /** Forgets the command with this id; forgetting an unknown id succeeds. */
  readonly remove: (commandId: string) => Promise<void>
}

/**
 * An offline store could not read or write a queued command. A command whose
 * `save` failed was never sent, so nothing about it is unknown.
 */
export class OfflineStoreError extends Schema.TaggedError<OfflineStoreError>()(
  "OfflineStoreError",
  { operation: Schema.Literals(["entries", "save", "remove"]), cause: Schema.Defect() },
) {}

/** An IndexedDB store could not be opened; `cause` is the browser's error when it gave one. */
class IndexedDbUnavailable extends Schema.TaggedError<IndexedDbUnavailable>()(
  "IndexedDbUnavailable",
  { reason: Schema.Literals(["absent", "blocked", "failed"]), cause: Schema.Defect() },
) {}

const bySequence = (left: QueuedCommand, right: QueuedCommand) => left.sequence - right.sequence

/** Keeps commands in memory, for tests and for pages that need the queue but not a reload. */
const memory = (): OfflineStore => {
  const commands = new Map<string, QueuedCommand>()

  return {
    entries: () =>
      Promise.resolve(
        Array.from(commands.values(), (command) => structuredClone(command)).sort(bySequence),
      ),
    save: (command) => {
      commands.set(command.commandId, structuredClone(command))

      return Promise.resolve()
    },
    remove: (commandId) => {
      commands.delete(commandId)

      return Promise.resolve()
    },
  }
}

const COMMANDS = "commands"

/**
 * Keeps commands in an IndexedDB database named `akter:<name>`, one
 * record per command. The database opens on first use, so building a client
 * on a server, where there is none, fails only when a command is queued.
 * Writes ask for strict durability: a record is on disk when `save` resolves.
 */
const indexedDb = (name: string): OfflineStore => {
  let opening: Deferred.Deferred<IDBDatabase, IndexedDbUnavailable> | undefined

  const openDatabase = Effect.callback<IDBDatabase, IndexedDbUnavailable>((resume) => {
    if (!("indexedDB" in globalThis))
      return resume(Effect.fail(IndexedDbUnavailable.make({ reason: "absent", cause: undefined })))

    const request = globalThis.indexedDB.open(`akter:${name}`, 1)

    request.onupgradeneeded = () => {
      request.result.createObjectStore(COMMANDS, { keyPath: "commandId" })
    }

    request.onsuccess = () => {
      const opened = request.result

      opened.onversionchange = () => {
        opened.close()
        opening = undefined
      }

      resume(Effect.succeed(opened))
    }

    request.onerror = () =>
      resume(Effect.fail(IndexedDbUnavailable.make({ reason: "failed", cause: request.error })))
    request.onblocked = () =>
      resume(Effect.fail(IndexedDbUnavailable.make({ reason: "blocked", cause: undefined })))
  })

  const database = Effect.suspend(() => {
    if (opening !== undefined) return Deferred.await(opening)

    const attempt = Deferred.makeUnsafe<IDBDatabase, IndexedDbUnavailable>()

    opening = attempt

    return openDatabase.pipe(
      Deferred.into(attempt),
      Effect.andThen(Deferred.await(attempt)),
      Effect.tapError(() =>
        Effect.sync(() => {
          if (opening === attempt) opening = undefined
        }),
      ),
    )
  })

  const transact = <A>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<A>) =>
    Effect.runPromise(
      database.pipe(
        Effect.flatMap((connection) =>
          Effect.callback<A, DOMException | null>((resume) => {
            const transaction = connection.transaction(COMMANDS, mode, { durability: "strict" })
            const request = run(transaction.objectStore(COMMANDS))

            transaction.oncomplete = () => resume(Effect.succeed(request.result))
            transaction.onerror = () => resume(Effect.fail(transaction.error ?? request.error))
            transaction.onabort = () => resume(Effect.fail(transaction.error ?? request.error))
          }),
        ),
      ),
    )

  return {
    entries: () =>
      transact("readonly", (store) => store.getAll() as IDBRequest<Array<QueuedCommand>>).then(
        (commands) => commands.sort(bySequence),
      ),
    save: (command) => transact("readwrite", (store) => store.put(command)).then(() => undefined),
    remove: (commandId) =>
      transact("readwrite", (store) => store.delete(commandId)).then(() => undefined),
  }
}

/** The storage adapters a client's `offline` option accepts. */
export const Offline = { indexedDb, memory }
