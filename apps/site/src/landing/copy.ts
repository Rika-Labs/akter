/** One numbered callout in the cutaway diagram, with its bold lead-in and the line that follows. */
export interface Callout {
  readonly lead: string
  readonly text: string
}

/** The five callouts, numbered to match the badges on the cutaway container. */
export const callouts: ReadonlyArray<Callout> = [
  { lead: "An address.", text: "Order/ord_8f2c, reachable from anywhere." },
  { lead: "Commands, one at a time.", text: "Each one commits in its own transaction." },
  { lead: "State and tables.", text: "Rows in your Postgres, owned by this actor." },
  { lead: "Events and jobs.", text: "Durable, retried, and run after the commit." },
  { lead: "Live clients.", text: "Connections that stay open while it sleeps." },
]

/** One use case: a sentence about what the actor is, and the scene that illustrates it. */
export interface UseCase {
  readonly kind: "realtime" | "background" | "agent"
  readonly title: string
  readonly text: string
}

/** The three things the headline promises, each as one kind of actor. */
export const useCases: ReadonlyArray<UseCase> = [
  {
    kind: "realtime",
    title: "A chat room is an actor.",
    text: "Rooms, documents and dashboards that keep their history and push every change to connected clients.",
  },
  {
    kind: "background",
    title: "A billing run is an actor.",
    text: "Payments, imports and billing runs that retry with backoff, run on schedules, and never quietly vanish.",
  },
  {
    kind: "agent",
    title: "An agent session is an actor.",
    text: "Sessions that keep their transcript, pause for an approval, and resume after a crash or a deploy.",
  },
]

/** The primitives the landing page lists, each with the one thing it does. */
export const primitives: ReadonlyArray<{ readonly name: string; readonly does: string }> = [
  { name: "Actor.make", does: "Identity, state and tables" },
  { name: "Actor.command", does: "Typed, one at a time" },
  { name: "Actor.job", does: "Retries and schedules" },
  { name: "Actor.event", does: "Durable, with a cursor" },
  { name: "Actors.serve", does: "Embedded, served or hosted" },
]

/** The landing page's questions, answered from the README and the repository's own wording. */
export const questions: ReadonlyArray<{ readonly question: string; readonly answer: string }> = [
  {
    question: "What is an actor, exactly?",
    answer:
      "An addressable part of your app, such as one order, one room or one agent session. It handles one command at a time and owns its data, its background work and its live connections.",
  },
  {
    question: "Do I need Postgres?",
    answer:
      "Your data lives in Postgres, as ordinary tables you can query with plain SQL. To start, PGlite, an embedded Postgres, runs the same code with no Docker or database server; Database.postgres points it at a real server. In the alpha, run one runtime process per database.",
  },
  {
    question: "Can I run it inside my existing server?",
    answer:
      "Yes. Embedded, you provide Actors.layer and call actors as Effects in your own process. Served, Actors.serve exposes the same actors over HTTP, WebSocket and SSE, with an OpenAPI document and an MCP endpoint.",
  },
  {
    question: "What happens when a process dies mid-command?",
    answer:
      "Before the commit, nothing was written, and a retry with the same command ID places the order once. After the commit but before the reply, the retry finds the stored result and returns it without running the handler again.",
  },
  {
    question: "How is this different from a workflow engine?",
    answer:
      "Temporal and Restate record a function's steps so it can resume after a crash. An Akter command is a short transaction instead, and anything slow becomes a job or a workflow owned by the actor.",
  },
  {
    question: "Is there a hosted version?",
    answer:
      "Akter cloud, with managed runners, Postgres and an inspector for every actor, is in development and its pricing here is a placeholder. The framework is Apache-2.0 and runs wherever Bun does.",
  },
]
