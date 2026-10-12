/**
 * Span names are public: dashboards and alerts match
 * on them, so a rename is a breaking change. Every name is bounded by the
 * deployment's declarations, never by an actor id or command id; those are
 * attributes.
 */
export const SpanNames = {
  /** One command's admission on the runner that received it, from the receipt probe to the reply. */
  admission: "akter.admission",
  /** One command turn on the actor's owner. */
  turn: (actor: string, command: string) => `akter.${actor}/${command}`,
  /** One turn batch on the actor's owner: the commands that were waiting, run in one transaction. */
  batch: (actor: string) => `akter.${actor}/batch`,
  /** The turn's commit group, from the first staged write to the `COMMIT` reply. */
  commit: "akter.commit",
  /** One executor attempt of a job. */
  job: (actor: string, job: string) => `akter.job/${actor}/${job}`,
} as const
