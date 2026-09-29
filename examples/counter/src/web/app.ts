/**
 * The counter in a browser, over the Promise client: the count follows the
 * counter's event feed, so every open page sees each increment as it commits.
 */
import { ActorError, type Failure, NotCreated } from "@durable-actors/core/client"
import { Effect } from "effect"
import { Counter, Incremented } from "../counter/contract.ts"

const query = new URLSearchParams(location.search)

const user = query.get("user") ?? "alice"

const counterId = location.pathname.split("/").at(-1) || "visits"

const element = <E extends HTMLElement>(id: string) =>
  document.querySelector<E>(`[data-testid="${id}"]`)!

const count = element<HTMLElement>("count")

const status = element<HTMLElement>("feed-status")

const notice = element<HTMLElement>("notice")

element<HTMLElement>("counter").textContent = counterId

element<HTMLElement>("user").textContent = user

const counters = Counter.client({
  baseUrl: "/api",
  headers: () => ({ authorization: `Bearer ${user}` }),
})

const counter = counters.get(counterId)

/**
 * A feed never creates its counter: until the first increment does, the page waits and asks again.
 */
const follow = async (after?: string): Promise<void> => {
  let cursor = after

  try {
    status.textContent = "live"

    for await (const entry of counter.events(Incremented, { after: cursor })) {
      cursor = entry.cursor
      count.textContent = String(entry.event.count)
      count.dataset.cursor = entry.cursor
    }
  } catch (error) {
    if (error instanceof ActorError && error.reason instanceof NotCreated) {
      status.textContent = "waiting for the first increment"
      await Effect.runPromise(Effect.sleep("500 millis"))

      return follow(cursor)
    }

    status.textContent = error instanceof ActorError ? `ended: ${error.reason._tag}` : "ended"
  }
}

element<HTMLButtonElement>("increment").addEventListener("click", () => {
  notice.textContent = ""

  counter.Increment(1).catch((error: Failure) => {
    notice.textContent =
      error instanceof ActorError ? `not counted: ${error.reason._tag}` : "not counted"
  })
})

void follow()
