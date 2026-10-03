import type { DeadLetter, JobsSummary } from "@akter/cloud-api"
import { formatDuration } from "@akter/ui/geometry"
import { DateTime } from "effect"
import { ago, hourLabel, splitAddress } from "../overview/time.ts"
import { JobsPage } from "./model.ts"
import type { DeadLetter as DeadLetterRow } from "./model.ts"

/** One dead letter as a row; `id` stays the dead letter's own id so retry and discard address it. */
export const toDeadLetter =
  (now: DateTime.Utc) =>
  (letter: DeadLetter): DeadLetterRow => {
    const { actorType, key } = splitAddress(letter.actor)
    return {
      id: letter.id,
      jobId: letter.jobId,
      job: letter.jobName,
      actorType,
      key,
      attempts: letter.attempts,
      error: letter.lastError,
      since: ago(now)(letter.since),
    }
  }

/** The job queue the runtime reports, with its dead letters, as the console's page. */
export const toJobsPage =
  (now: DateTime.Utc) =>
  (input: Readonly<{ summary: JobsSummary; deadLetters: ReadonlyArray<DeadLetter> }>): JobsPage => {
    const throughput = [...input.summary.throughput].sort(
      (left, right) => DateTime.toEpochMillis(left.at) - DateTime.toEpochMillis(right.at),
    )
    return JobsPage.make({
      queued: input.summary.queued,
      running: input.summary.running,
      retrying: input.summary.retrying,
      deadLetters: input.deadLetters.map(toDeadLetter(now)),
      types: input.summary.byType.map((type) => ({
        name: type.jobName,
        done: type.done,
        retried: type.retried,
        dead: type.dead,
        p99: formatDuration(type.p99Ms),
      })),
      labels: throughput.map((point) => hourLabel(point.at)),
      throughput: throughput.map((point) => point.value),
    })
  }
