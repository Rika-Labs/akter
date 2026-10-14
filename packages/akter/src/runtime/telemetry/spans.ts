/**
 * Span names are public: dashboards and alerts match
 * on them, so a rename is a breaking change. Every name is bounded by the
 * deployment's declarations, never by an actor id or command id; those are
 * attributes.
 */
export const SpanNames = {
  /** One command's admission on the gateway to the reply. */
  admission: "akter.admission",
  /** One command turn on the actor's owner. */
  turn: (actor: string, command: string) => `akter.${actor}/${command}`,
  /** One create-once segment append. */
  commit: "akter.commit",
  /** One executor attempt of a job. */
  job: (actor: string, job: string) => `akter.job/${actor}/${job}`,
  /** One cross-shard send or timer firing. */
  delivery: "akter.delivery",
} as const
