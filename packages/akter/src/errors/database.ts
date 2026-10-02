import { Schema } from "effect"

/** Another process, or another open layer in this one, holds the data directory's lock. */
export class DataDirLocked extends Schema.TaggedError<DataDirLocked>()("DataDirLocked", {
  dataDir: Schema.String,
}) {
  override get message() {
    return `PGlite data directory ${this.dataDir} is in use by another process; one process may open it at a time`
  }
}

/**
 * The data directory was written by another Postgres major than the pinned
 * PGlite embeds, which Postgres cannot open. Dump it with the core release
 * that wrote it and load the dump into a new directory.
 */
export class DataDirVersion extends Schema.TaggedError<DataDirVersion>()("DataDirVersion", {
  dataDir: Schema.String,
  found: Schema.String,
  expected: Schema.String,
}) {
  override get message() {
    return `PGlite data directory ${this.dataDir} is Postgres ${this.found}, but this release embeds Postgres ${this.expected}; dump it with the release that wrote it and load the dump into a new directory`
  }
}
