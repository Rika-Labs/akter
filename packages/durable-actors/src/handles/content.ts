import { Context, Effect, type Option, type Stream } from "effect"
import { outsideTurn } from "../contexts/command.ts"
import type { ActorError } from "../errors/actor.ts"
import type { ContentTooLarge } from "../errors/content.ts"
import { type ActorRef, type Caller, CurrentCaller, Tenant } from "../identity/caller.ts"
import type { ContentRef } from "../identity/content.ts"
import type { AnyContent } from "../members/blob.ts"

/**
 * The runtime's content operations. They write framework rows on a tenant's
 * shard outside any turn, so effect executors, which hold no database
 * capability, never receive this service.
 */
export class ContentStore extends Context.Service<
  ContentStore,
  {
    /** Stores bytes already in memory for `tenant` and returns a fresh grant. */
    readonly uploadBytes: (
      tenant: string,
      bytes: Uint8Array,
    ) => Effect.Effect<ContentRef, ContentTooLarge | ActorError>
    /**
     * Stores a body as it arrives, hashing it on the way; past `limit` bytes
     * it fails `ContentTooLarge` and stores nothing.
     */
    readonly upload: (
      tenant: string,
      body: Stream.Stream<Uint8Array, ActorError>,
      limit: number,
    ) => Effect.Effect<ContentRef, ContentTooLarge | ActorError>
    /**
     * A fresh grant for the content `ref` references under `blob`/`name`, after
     * `authorize` allows `caller` the operation `<blob>.grant`; none for a
     * missing name or content swept meanwhile.
     */
    readonly grant: (
      ref: ActorRef,
      caller: Caller,
      blob: string,
      name: string,
    ) => Effect.Effect<Option.Option<ContentRef>, ActorError>
    /**
     * The referenced content's size and bytes, after `authorize` allows
     * `caller` the operation `<blob>.get`; none for a missing name. The bytes
     * come from one snapshot; content swept after the reference resolved
     * fails the stream before any chunk.
     */
    readonly download: (
      ref: ActorRef,
      caller: Caller,
      blob: string,
      name: string,
    ) => Effect.Effect<
      Option.Option<{
        readonly size: number
        readonly bytes: Stream.Stream<Uint8Array, ActorError>
      }>,
      ActorError
    >
  }
>()("@durable-actors/core/handles/content/ContentStore") {}

/**
 * Content operations for code outside turns, queries, and executors, with
 * the ambient tenant and caller.
 */
export const Content = {
  /**
   * Stores `bytes` once for the ambient tenant, up to 64 MiB, and returns a
   * reference whose grant lasts an hour. Uploading bytes the tenant already
   * holds stores nothing new and returns a fresh grant.
   */
  upload: (bytes: Uint8Array): Effect.Effect<ContentRef, ContentTooLarge | ActorError, ContentStore> =>
    Effect.gen(function* () {
      yield* outsideTurn
      const store = yield* ContentStore

      return yield* store.uploadBytes(yield* Tenant, bytes)
    }),
  /**
   * A fresh grant for the content an actor references, so another actor's
   * turn can attach it. `authorize` sees the ambient caller with kind
   * `content` and command `<blob>.grant`. None when the actor holds no reference under `name`.
   */
  grant: (
    actor: { readonly name: string },
    id: string,
    blob: AnyContent,
    name: string,
  ): Effect.Effect<Option.Option<ContentRef>, ActorError, ContentStore> =>
    Effect.gen(function* () {
      yield* outsideTurn
      const store = yield* ContentStore

      return yield* store.grant(
        { tenant: yield* Tenant, actor: actor.name, id },
        yield* CurrentCaller,
        blob.name,
        name,
      )
    }),
}
