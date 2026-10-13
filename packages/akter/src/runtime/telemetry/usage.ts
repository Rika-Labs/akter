/** Runner-local attribution, never storage or billing authority. */
export interface UsageTotals {
  readonly actions: number
  readonly jobSeconds: number
}

/** One actor type's attribution since this runner opened. */
export interface ActorUsage extends UsageTotals {
  readonly actorType: string
}

/** A detached, monotonic snapshot; active attempts enter it only when they settle or are interrupted. */
export interface UsageSnapshot extends UsageTotals {
  readonly actors: ReadonlyArray<ActorUsage>
}

/** Attribution stays with the runner across shard recovery and reassignment, not with checkpoint state. */
export class UsageLedger {
  private readonly actors: Map<string, UsageTotals>

  constructor(actors: Iterable<string>) {
    this.actors = new Map(Array.from(actors, (actor) => [actor, { actions: 0, jobSeconds: 0 }]))
  }

  add(actor: string, actions: number, jobSeconds: number): void {
    const previous = this.actors.get(actor) ?? { actions: 0, jobSeconds: 0 }
    this.actors.set(actor, {
      actions: previous.actions + actions,
      jobSeconds: previous.jobSeconds + jobSeconds,
    })
  }

  snapshot(): UsageSnapshot {
    const actors = Array.from(this.actors, ([actorType, totals]) => ({ actorType, ...totals }))
    return {
      actions: actors.reduce((total, actor) => total + actor.actions, 0),
      jobSeconds: actors.reduce((total, actor) => total + actor.jobSeconds, 0),
      actors,
    }
  }
}
