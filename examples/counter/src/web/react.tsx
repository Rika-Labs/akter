// The counter with @durable-actors/react: the count from the event feed, and
// each click as one command with its own command id.
import { useActor, useCommand, useEventFeed } from "@durable-actors/react"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Counter, Incremented } from "../counter/contract.ts"

const query = new URLSearchParams(location.search)

const user = query.get("user") ?? "alice"

const counterId = location.pathname.split("/").at(-1) || "visits"

const counters = Counter.client({
  baseUrl: "/api",
  headers: () => ({ authorization: `Bearer ${user}` }),
})

const App = () => {
  const counter = useActor(counters, counterId)
  const feed = useEventFeed(counter, Incremented)

  const increment = useCommand(counters, (amount: number, options) =>
    counter.Increment(amount, options),
  )

  return (
    <main>
      <header>
        <h1>
          Counter <span data-testid="counter">{counterId}</span>
        </h1>
        <span className="meta">
          signed in as <strong data-testid="user">{user}</strong> · feed{" "}
          <span data-testid="feed-status">{feed.error === undefined ? "live" : "ended"}</span>
        </span>
      </header>
      <p className="count" data-testid="count">
        {feed.entries.at(-1)?.event.count ?? 0}
      </p>
      <div className="actions">
        <button
          type="button"
          data-testid="increment"
          onClick={() => void increment.run(1).catch(() => undefined)}
        >
          + Increment
        </button>
      </div>
      <p data-testid="notice">{increment.state.status === "error" ? "not counted" : ""}</p>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
