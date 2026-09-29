import { Clock, DateTime, Effect, Fiber, ManagedRuntime, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import {
  ActorDetail,
  ActorsPage,
  DeadLettersPage,
  EffectsPage,
  OutboxPage,
  Overview,
  WorkflowsPage,
} from "./schema.ts"
import {
  actorView,
  actorsView,
  deadLettersView,
  effectsView,
  h,
  outboxView,
  overviewTiles,
  workflowsView,
} from "./view.ts"

const element = (id: string) => document.getElementById(id)!

const root = element("app")

const tiles = element("tiles")

const tenant = element("tenant")

const updated = element("updated")

const live = element("live")

const api = document.body.dataset["api"] ?? "api"

const runtime = ManagedRuntime.make(FetchHttpClient.layer)

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {}) {}

const get = <S extends Schema.Top & { readonly DecodingServices: never }>(
  path: string,
  schema: S,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(`${api}${path}`)

    if (response.status === 404) return yield* NotFound.make({})

    return yield* HttpClientResponse.schemaBodyJson(schema)(
      yield* HttpClientResponse.filterStatusOk(response),
    )
  })

interface Route {
  readonly path: string
  readonly params: URLSearchParams
}

const route = (): Route => {
  const [path = "", query = ""] = location.hash.replace(/^#/, "").split("?")

  return {
    path: path === "" || path === "/" ? "/actors" : path,
    params: new URLSearchParams(query),
  }
}

const setActive = (path: string) => {
  for (const link of document.querySelectorAll<HTMLAnchorElement>("nav.sections a"))
    link.classList.toggle("active", path.startsWith(link.dataset["section"] ?? "\u0000"))
}

/** The tenant's first 500 actors, of one type or all. */
const actorPage = (type: string | undefined) => {
  const query = new URLSearchParams({ limit: "500" })

  if (type !== undefined) query.set("type", type)

  return get(`/actors?${query}`, ActorsPage)
}

/** The widest page the API serves; a list shorter than the tenant's count says it is truncated. */
const LIST = "limit=500"

const view = ({ path, params }: Route, now: number, counts: Overview["counts"]) =>
  Effect.gen(function* () {
    if (path.startsWith("/actor/")) {
      const [, , type = "", id = ""] = path.split("/")

      const query = new URLSearchParams({
        type: decodeURIComponent(type),
        id: decodeURIComponent(id),
      })

      return actorView({ detail: yield* get(`/actor?${query}`, ActorDetail), now })
    }

    if (path === "/outbox")
      return outboxView({
        rows: (yield* get(`/outbox?${LIST}`, OutboxPage)).outbox,
        total: counts.outbox,
        now,
      })

    if (path === "/effects")
      return effectsView({
        rows: (yield* get(`/effects?${LIST}`, EffectsPage)).effects,
        total: counts.effects,
        now,
      })

    if (path === "/dead-letters")
      return deadLettersView({
        rows: (yield* get(`/dead-letters?${LIST}`, DeadLettersPage)).deadLetters,
        total: counts.deadLetters,
      })

    if (path === "/workflows") {
      const all = params.get("status") === "all"
      const page = yield* get(`/workflows?status=${all ? "all" : "open"}&${LIST}`, WorkflowsPage)

      return workflowsView({
        rows: page.workflows,
        total: all ? counts.workflows : counts.openWorkflows,
        now,
        all,
      })
    }

    const selected = params.get("type") ?? undefined
    const everyType = yield* actorPage(undefined)
    const types = [...new Set(everyType.actors.map((actor) => actor.actorType))]
    const page = selected === undefined ? everyType : yield* actorPage(selected)

    return actorsView({
      actors: page.actors,
      types,
      selected,
      more:
        page.next === null
          ? null
          : h("p", { class: "hint" }, "Showing the first 500 actors; filter by type to narrow."),
    })
  })

const notFound = () =>
  h(
    "section",
    { class: "card" },
    h("h2", null, "Not found"),
    h("p", { class: "empty" }, "This tenant has no such actor."),
  )

const render = Effect.gen(function* () {
  const current = route()
  const now = yield* Clock.currentTimeMillis
  setActive(current.path)

  const overview = yield* get("/overview", Overview)
  tenant.textContent = overview.tenant
  tiles.replaceChildren(overviewTiles(overview))

  const content = yield* view(current, now, overview.counts).pipe(
    Effect.catchTag("NotFound", () => Effect.sync(notFound)),
  )

  root.replaceChildren(content)
  updated.textContent = `Updated ${DateTime.formatLocal(DateTime.makeUnsafe(now), { timeStyle: "medium" })}`
}).pipe(
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      root.replaceChildren(
        h(
          "section",
          { class: "card error" },
          h("h2", null, "The inspector API did not answer"),
          h("pre", null, String(cause)),
        ),
      )
    }),
  ),
)

let running: Fiber.Fiber<void> | undefined

const refresh = () => {
  if (running !== undefined) runtime.runFork(Fiber.interrupt(running))
  running = runtime.runFork(render)
}

window.addEventListener("hashchange", refresh)

element("refresh").addEventListener("click", refresh)

root.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-scroll]") : null
  const id = target?.getAttribute("data-scroll")
  const found = id === null || id === undefined ? null : document.getElementById(id)

  if (found === null) return

  found.scrollIntoView({ behavior: "smooth", block: "center" })
  found.classList.add("flash")
  runtime.runFork(
    Effect.sleep("1200 millis").pipe(
      Effect.andThen(Effect.sync(() => found.classList.remove("flash"))),
    ),
  )
})

runtime.runFork(
  Effect.sync(() => {
    if (live instanceof HTMLInputElement && live.checked && document.visibilityState === "visible")
      refresh()
  }).pipe(Effect.repeat(Schedule.spaced("2 seconds"))),
)

refresh()
