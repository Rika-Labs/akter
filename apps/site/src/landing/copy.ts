/** The three things the headline promises, each with the sentence the "What you build" row shows. */
export const builds: ReadonlyArray<{ readonly title: string; readonly text: string }> = [
  {
    title: "Realtime apps.",
    text: "A chat room, a document or a dashboard keeps its history and pushes every change to the people connected to it.",
  },
  {
    title: "Background work.",
    text: "A billing run or an import retries with backoff, runs on a schedule, and never quietly vanishes.",
  },
  {
    title: "Agents.",
    text: "An agent session keeps its transcript, pauses for an approval, and picks up where it left off after a crash or a deploy.",
  },
]

/** The three places Akter runs, numbered as the cards show them, with each card's crane crop. */
export const places: ReadonlyArray<{
  readonly number: string
  readonly title: string
  readonly text: string
  readonly viewBox: string
}> = [
  {
    number: "001",
    title: "In your process",
    text: "Call actors directly. Starts on an embedded Postgres database with nothing to install.",
    viewBox: "20 110 300 120",
  },
  {
    number: "002",
    title: "On your servers",
    text: "The same actors over HTTP, WebSocket and SSE, on any Postgres server you run.",
    viewBox: "380 10 340 220",
  },
  {
    number: "003",
    title: "Akter Cloud",
    text: "Managed runners and Postgres databases, with an inspector for every actor. In development.",
    viewBox: "750 80 320 150",
  },
]

/** The landing page's questions, answered from the README and the repository's own wording. */
export const questions: ReadonlyArray<{ readonly question: string; readonly answer: string }> = [
  {
    question: "What is an actor, exactly?",
    answer:
      "An addressable part of your app, such as one order, one room or one agent session. It handles one command at a time and owns its data, its background work and its live connections.",
  },
  {
    question: "Do I need a Postgres database?",
    answer:
      "Your data lives in a Postgres database, as ordinary tables you can query with plain SQL. To start, PGlite, an embedded Postgres database, runs the same code with no Docker or database server; Database.postgres points it at a real Postgres server. In the alpha, run one runtime process per database.",
  },
  {
    question: "Can I run it inside my existing server?",
    answer:
      "Yes. Embedded, you provide Actors.layer and call actors as Effects in your own process. Served, Actors.serve exposes the same actors over HTTP, WebSocket and SSE, with an OpenAPI document and an MCP endpoint.",
  },
  {
    question: "What happens when a process dies mid-request?",
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
      "Akter Cloud, with managed runners, Postgres databases and an inspector for every actor, is in development and its pricing here is a placeholder. The framework is Apache-2.0 and runs wherever Bun does.",
  },
]
