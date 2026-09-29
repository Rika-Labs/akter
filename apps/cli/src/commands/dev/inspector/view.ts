import { DateTime, Match } from "effect"
import type {
  ActorDetail,
  ActorRow,
  DeadLetterRow,
  Decoded,
  EffectRow,
  EventRow,
  Overview,
  OutboxRow,
  ReceiptRow,
  StepRow,
  WorkflowRow,
} from "./schema.ts"

type Child = Node | string | number | null | undefined | false

/**
 * Builds an element. Children are text nodes, never parsed as HTML: every
 * value on the page is actor data, and none of it may become markup.
 */
export const h = (
  tag: string,
  attributes: Readonly<Record<string, string>> | null,
  ...children: ReadonlyArray<Child | ReadonlyArray<Child>>
) => {
  const element = document.createElement(tag)

  for (const [name, value] of Object.entries(attributes ?? {})) element.setAttribute(name, value)

  for (const child of children.flat())
    if (child !== null && child !== undefined && child !== false)
      element.append(child instanceof Node ? child : document.createTextNode(String(child)))

  return element
}

/** A link to one actor's page. */
export const actorHref = ({
  actorType,
  actorId,
}: {
  readonly actorType: string
  readonly actorId: string
}) => `#/actor/${encodeURIComponent(actorType)}/${encodeURIComponent(actorId)}`

const time = (ms: number | null) => {
  if (ms === null) return h("span", { class: "muted" }, "—")

  const at = DateTime.makeUnsafe(ms)
  const iso = DateTime.formatIso(at)

  return h(
    "time",
    { datetime: iso, title: iso },
    DateTime.formatLocal(at, { dateStyle: "medium", timeStyle: "medium" }),
  )
}

const relative = (ms: number, now: number) => {
  const seconds = Math.round((ms - now) / 1000)
  const magnitude = Math.abs(seconds)

  const text =
    magnitude < 60
      ? `${magnitude}s`
      : magnitude < 3600
        ? `${Math.round(magnitude / 60)}m`
        : magnitude < 86_400
          ? `${Math.round(magnitude / 3600)}h`
          : `${Math.round(magnitude / 86_400)}d`

  return seconds >= 0 ? `in ${text}` : `${text} ago`
}

const due = (ms: number, now: number) =>
  h(
    "span",
    { class: ms <= now ? "due overdue" : "due" },
    time(ms),
    " ",
    h("small", null, relative(ms, now)),
  )

/** A decoded value as indented JSON, or why it could not be decoded. */
export const json = (value: Decoded | null) => {
  if (value === null) return h("span", { class: "muted" }, "—")

  if ("undecodable" in value)
    return h("span", { class: "badge bad" }, `undecodable: ${value.undecodable}`)

  return h("pre", { class: "json" }, JSON.stringify(value.json, null, 2))
}

const tag = (text: string, tone: Tone = "plain") =>
  h("span", { class: `badge ${tone}`, title: text }, text)

type Tone = "good" | "bad" | "warn" | "info" | "plain"

const table = (headers: ReadonlyArray<string>, rows: ReadonlyArray<Node>, empty: string) =>
  rows.length === 0
    ? h("p", { class: "empty" }, empty)
    : h(
        "table",
        null,
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            headers.map((header) => h("th", null, header)),
          ),
        ),
        h("tbody", null, rows),
      )

const section = (
  title: string,
  count: string | null,
  ...body: ReadonlyArray<Child | ReadonlyArray<Child>>
) =>
  h(
    "section",
    { class: "card" },
    h("h2", null, title, count === null ? null : h("span", { class: "count" }, count)),
    ...body,
  )

const shown = (length: number, total: number) =>
  length === total ? String(total) : `${length} of ${total}`

const actorLink = (row: { readonly actorType: string; readonly actorId: string }) =>
  h("a", { href: actorHref(row) }, `${row.actorType}/${row.actorId}`)

const COUNTS: ReadonlyArray<readonly [keyof Overview["counts"], string, string]> = [
  ["actors", "Actors", "#/actors"],
  ["receipts", "Receipts", "#/actors"],
  ["events", "Events", "#/actors"],
  ["outbox", "Outbox", "#/outbox"],
  ["timers", "Timers", "#/outbox"],
  ["effects", "Effects", "#/effects"],
  ["deadLetters", "Dead letters", "#/dead-letters"],
  ["openWorkflows", "Open workflows", "#/workflows"],
]

/** The tenant's row counts, one tile per view. */
export const overviewTiles = (overview: Overview) =>
  h(
    "div",
    { class: "tiles" },
    COUNTS.map(([key, label, href]) =>
      h(
        "a",
        { class: key === "deadLetters" && overview.counts[key] > 0 ? "tile alert" : "tile", href },
        h("strong", null, overview.counts[key]),
        h("span", null, label),
      ),
    ),
  )

/** The actors table with its type filter. */
export const actorsView = ({
  actors,
  types,
  selected,
  more,
}: {
  readonly actors: ReadonlyArray<ActorRow>
  readonly types: ReadonlyArray<string>
  readonly selected: string | undefined
  readonly more: Node | null
}) =>
  section(
    "Actors",
    String(actors.length),
    h(
      "nav",
      { class: "filters" },
      h("a", { class: selected === undefined ? "chip active" : "chip", href: "#/actors" }, "All"),
      types.map((type) =>
        h(
          "a",
          {
            class: selected === type ? "chip active" : "chip",
            href: `#/actors?type=${encodeURIComponent(type)}`,
          },
          type,
        ),
      ),
    ),
    table(
      ["Actor", "Placement", "Generation", "Created", "Last event"],
      actors.map((actor) =>
        h(
          "tr",
          null,
          h("td", null, actorLink(actor)),
          h("td", null, actor.placement ?? "—"),
          h("td", { class: "num" }, actor.generation),
          h("td", null, actor.created ? tag("created", "good") : tag("implicit")),
          h("td", { class: "num" }, actor.lastEventSequence),
        ),
      ),
      "No actors in this tenant yet. Send a command to the app and refresh.",
    ),
    more,
  )

const outcomeTone = (outcome: string | null) =>
  Match.value(outcome).pipe(
    Match.when("Success", (): Tone => "good"),
    Match.when("Failure", (): Tone => "bad"),
    Match.orElse((): Tone => "plain"),
  )

const receiptRow = (receipt: ReceiptRow, now: number) =>
  h(
    "tr",
    null,
    h("td", null, h("code", null, receipt.command)),
    h("td", null, tag(receipt.outcomeTag ?? "?", outcomeTone(receipt.outcomeTag))),
    h(
      "td",
      null,
      receipt.events.length === 0
        ? h("span", { class: "muted" }, "nothing else")
        : receipt.events.map((sequence) =>
            h(
              "button",
              { type: "button", class: "chip", "data-scroll": `event-${sequence}` },
              `event ${sequence}`,
            ),
          ),
    ),
    h("td", null, h("details", null, h("summary", null, "outcome"), json(receipt.outcome))),
    h("td", null, due(receipt.expiresAtMs, now)),
    h("td", { class: "mono small" }, receipt.commandId),
  )

const eventRow = (event: EventRow) =>
  h(
    "li",
    { id: `event-${event.sequence}`, class: "event" },
    h(
      "div",
      { class: "event-head" },
      h("span", { class: "seq" }, `#${event.sequence}`),
      h("code", null, event.event),
      time(event.emittedAtMs),
      h("small", { class: "muted" }, `${event.bytes} B compressed`),
    ),
    json(event.value),
  )

const outboxRow = (row: OutboxRow, now: number, withActor: boolean) =>
  h(
    "tr",
    null,
    withActor ? h("td", null, actorLink(row)) : null,
    h(
      "td",
      null,
      row.timerKey === null ? tag("intent", "info") : tag(`timer ${row.timerKey}`, "warn"),
    ),
    h("td", null, h("code", null, `${row.targetType}/${row.targetId}.${row.command}`)),
    h("td", null, json(row.payload)),
    h("td", { class: "num" }, row.attempts),
    h("td", null, row.lastError ?? h("span", { class: "muted" }, "—")),
    h("td", null, due(row.dueAtMs, now)),
  )

const effectRow = (row: EffectRow, now: number, withActor: boolean) =>
  h(
    "tr",
    null,
    withActor ? h("td", null, actorLink(row)) : null,
    h("td", null, h("code", null, row.effect)),
    h("td", null, json(row.payload)),
    h("td", { class: "num" }, row.attempts),
    h("td", null, row.ambiguous ? tag("ambiguous", "warn") : tag("known")),
    h("td", null, row.lastError ?? h("span", { class: "muted" }, "—")),
    h("td", null, due(row.dueAtMs, now)),
  )

// A cause is often a stack trace; its first line is what an operator scans for.
const cause = (text: string) => {
  const [first = "", ...rest] = text.split("\n")

  return rest.length === 0
    ? first
    : h("details", null, h("summary", null, first), h("pre", { class: "trace" }, rest.join("\n")))
}

const deadLetterRow = (row: DeadLetterRow, withActor: boolean) =>
  h(
    "tr",
    null,
    withActor ? h("td", null, actorLink(row)) : null,
    h("td", null, h("code", null, row.effect)),
    h("td", null, json(row.payload)),
    h("td", { class: "num" }, row.attempts),
    h("td", null, row.ambiguous ? tag("ambiguous", "warn") : tag("known")),
    h("td", { class: "cause" }, cause(row.cause)),
    h("td", null, time(row.deadAtMs)),
  )

const stepTone = (step: StepRow) => (step.exit === null ? "warn" : "good")

const stepRow = (step: StepRow, now: number) =>
  h(
    "tr",
    null,
    h("td", null, h("code", null, step.step)),
    h("td", null, tag(step.kind, "info")),
    h("td", { class: "num" }, step.attempt),
    h("td", null, tag(step.exit === null ? "pending" : "settled", stepTone(step))),
    h(
      "td",
      null,
      step.dueAtMs === null ? null : due(step.dueAtMs, now),
      step.waitEvent === null
        ? null
        : h("span", null, "waits for ", h("code", null, step.waitEvent)),
      step.version === null ? null : h("span", null, `version ${step.version}`),
    ),
    h("td", null, time(step.startedAtMs)),
    h("td", null, time(step.settledAtMs)),
    h("td", null, json(step.exit)),
  )

const statusTone = (status: string) =>
  Match.value(status).pipe(
    Match.when("finished", (): Tone => "good"),
    Match.when("suspended", (): Tone => "warn"),
    Match.orElse((): Tone => "info"),
  )

/** One workflow execution with its step history. */
const workflowCard = (workflow: WorkflowRow, now: number, withActor: boolean) =>
  h(
    "article",
    { class: "workflow" },
    h(
      "header",
      null,
      h(
        "h3",
        null,
        h("code", null, workflow.workflow),
        " ",
        h("span", { class: "muted" }, workflow.workflowKey),
      ),
      tag(workflow.status, statusTone(workflow.status)),
      workflow.interrupt ? tag("interrupt requested", "bad") : null,
      withActor ? actorLink(workflow) : null,
    ),
    h(
      "dl",
      null,
      h("dt", null, "Started"),
      h("dd", null, time(workflow.startedAtMs)),
      h("dt", null, "Finished"),
      h("dd", null, time(workflow.finishedAtMs)),
      h("dt", null, "Execution"),
      h("dd", { class: "mono small" }, workflow.executionId),
    ),
    h(
      "div",
      { class: "split" },
      h("div", null, h("h4", null, "Input"), json(workflow.payload)),
      h("div", null, h("h4", null, "Result"), json(workflow.result)),
    ),
    h("h4", null, "Steps"),
    workflow.status === "finished"
      ? h(
          "p",
          { class: "empty" },
          "The engine deletes a finished execution's steps; its result is above.",
        )
      : table(
          ["Step", "Kind", "Attempt", "Status", "Waiting on", "Started", "Settled", "Exit"],
          workflow.steps.map((step) => stepRow(step, now)),
          "No step recorded yet.",
        ),
  )

const OUTBOX_HEADERS = ["Kind", "Target", "Payload", "Attempts", "Last error", "Due"]

const EFFECT_HEADERS = ["Effect", "Payload", "Attempts", "Outcome", "Last error", "Due"]

const DEAD_LETTER_HEADERS = ["Effect", "Payload", "Attempts", "Last attempt", "Cause", "Dead at"]

/** Everything the inspector knows about one actor. */
export const actorView = ({
  detail,
  now,
}: {
  readonly detail: ActorDetail
  readonly now: number
}) => {
  const { actor, totals } = detail

  return h(
    "div",
    { class: "stack" },
    h(
      "section",
      { class: "card hero" },
      h("p", { class: "crumbs" }, h("a", { href: "#/actors" }, "Actors"), " / ", actor.actorType),
      h("h1", null, `${actor.actorType}/${actor.actorId}`),
      h(
        "div",
        { class: "facts" },
        tag(`generation ${actor.generation}`, "info"),
        tag(`${actor.placement ?? "unknown"} placement`),
        actor.created ? tag("created", "good") : tag("implicit"),
        tag(`last event #${actor.lastEventSequence}`),
      ),
    ),
    section(
      "State",
      String(detail.state.length),
      detail.state.length === 0
        ? h("p", { class: "empty" }, "No state stored.")
        : h(
            "div",
            { class: "state" },
            detail.state.map((entry) =>
              h(
                "div",
                { class: "state-entry" },
                h(
                  "h3",
                  null,
                  h("code", null, entry.key),
                  h("small", { class: "muted" }, ` ${entry.bytes} B compressed`),
                ),
                json(entry.value),
              ),
            ),
          ),
    ),
    section(
      "Receipts",
      shown(detail.receipts.length, totals.receipts),
      h(
        "p",
        { class: "hint" },
        "Each command's outcome and the events that committed in the same turn.",
      ),
      table(
        ["Command", "Outcome", "Committed with it", "Outcome value", "Expires", "Command id"],
        detail.receipts.map((receipt) => receiptRow(receipt, now)),
        "No receipts retained.",
      ),
    ),
    section(
      "Events",
      shown(detail.events.length, totals.events),
      detail.events.length === 0
        ? h("p", { class: "empty" }, "No events retained.")
        : h("ol", { class: "timeline" }, detail.events.map(eventRow)),
    ),
    section(
      "Outbox and timers",
      shown(detail.outbox.length, totals.outbox),
      table(
        OUTBOX_HEADERS,
        detail.outbox.map((row) => outboxRow(row, now, false)),
        "Nothing pending.",
      ),
    ),
    section(
      "Effects",
      shown(detail.effects.length, totals.effects),
      table(
        EFFECT_HEADERS,
        detail.effects.map((row) => effectRow(row, now, false)),
        "No effect in flight.",
      ),
    ),
    section(
      "Dead letters",
      shown(detail.deadLetters.length, totals.deadLetters),
      table(
        DEAD_LETTER_HEADERS,
        detail.deadLetters.map((row) => deadLetterRow(row, false)),
        "No dead letters.",
      ),
    ),
    section(
      "Workflows",
      shown(detail.workflows.length, totals.workflows),
      detail.workflows.length === 0
        ? h("p", { class: "empty" }, "No workflow executions retained.")
        : detail.workflows.map((workflow) => workflowCard(workflow, now, false)),
    ),
  )
}

// A tenant-wide list is one page; say so when the tenant has more rows than it shows.
const truncated = (length: number, total: number) =>
  length < total
    ? h(
        "p",
        { class: "hint" },
        `Showing the first ${length} of ${total}. Open an actor for its own rows.`,
      )
    : null

/** The tenant's pending intents and timers. */
export const outboxView = ({
  rows,
  total,
  now,
}: {
  readonly rows: ReadonlyArray<OutboxRow>
  readonly total: number
  readonly now: number
}) =>
  section(
    "Outbox and timers",
    shown(rows.length, total),
    truncated(rows.length, total),
    table(
      ["Actor", ...OUTBOX_HEADERS],
      rows.map((row) => outboxRow(row, now, true)),
      "Nothing pending.",
    ),
  )

/** The tenant's effects in flight. */
export const effectsView = ({
  rows,
  total,
  now,
}: {
  readonly rows: ReadonlyArray<EffectRow>
  readonly total: number
  readonly now: number
}) =>
  section(
    "Effects",
    shown(rows.length, total),
    truncated(rows.length, total),
    table(
      ["Actor", ...EFFECT_HEADERS],
      rows.map((row) => effectRow(row, now, true)),
      "No effect in flight.",
    ),
  )

/** The tenant's dead letters. */
export const deadLettersView = ({
  rows,
  total,
}: {
  readonly rows: ReadonlyArray<DeadLetterRow>
  readonly total: number
}) =>
  section(
    "Dead letters",
    shown(rows.length, total),
    h(
      "p",
      { class: "hint" },
      "Retry or discard a dead letter with durable dead-letters, under operator authority.",
    ),
    truncated(rows.length, total),
    table(
      ["Actor", ...DEAD_LETTER_HEADERS],
      rows.map((row) => deadLetterRow(row, true)),
      "No dead letters.",
    ),
  )

/** The tenant's workflow executions. */
export const workflowsView = ({
  rows,
  total,
  now,
  all,
}: {
  readonly rows: ReadonlyArray<WorkflowRow>
  readonly total: number
  readonly now: number
  readonly all: boolean
}) =>
  section(
    "Workflows",
    shown(rows.length, total),
    truncated(rows.length, total),
    h(
      "nav",
      { class: "filters" },
      h("a", { class: all ? "chip" : "chip active", href: "#/workflows" }, "Open"),
      h("a", { class: all ? "chip active" : "chip", href: "#/workflows?status=all" }, "All"),
    ),
    rows.length === 0
      ? h(
          "p",
          { class: "empty" },
          all ? "No workflow executions retained." : "No open workflow executions.",
        )
      : rows.map((workflow) => workflowCard(workflow, now, true)),
  )
