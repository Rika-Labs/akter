import { Context, DateTime, Effect, Layer, Option, Predicate, Schedule, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"

/** The kinds of principal that can perform an audited action. */
export type AuditActorKind = "user" | "api-key"

/** Who performed an audited action: a signed-in user or an API key, and the name it had at the time. */
export interface AuditActor {
  readonly kind: AuditActorKind
  readonly id: string
  readonly name?: string | null | undefined
}

/** The organization an action belongs to and who performed it, written to the audit log. */
export interface Audited {
  readonly organizationId: string
  readonly actor: AuditActor
  readonly ip?: string | null | undefined
}

/** What an audit entry points at; `id` and `name` are null when the action has no single subject. */
export interface AuditTarget {
  readonly type: string
  readonly id?: string | null | undefined
  readonly name?: string | null | undefined
}

export type EnvironmentName = "production" | "staging" | "dev"

export type ProjectStatus = "empty" | "live" | "deploying" | "failed"

/** A project, owned by exactly one organization. */
export interface Project {
  readonly id: string
  readonly organizationId: string
  readonly name: string
  readonly slug: string
  readonly status: ProjectStatus
  readonly homeRegion: string
  readonly createdAt: DateTime.Utc
}

/** An environment of one project, identified by the project and its name. */
export interface Environment {
  readonly name: EnvironmentName
  readonly projectId: string
  readonly currentDeploymentId: string | null
}

export type Theme = "light" | "dark" | "system"

/** One user's settings within one organization. */
export interface Preferences {
  readonly defaultEnvironment: EnvironmentName
  readonly openActorLinksInNewTab: boolean
  readonly timeZone: string
  readonly pauseLiveTailOnScroll: boolean
  readonly showReplayedCommands: boolean
  readonly theme: Theme
}

export type NotificationEvent = "deploy_failed" | "dead_letter" | "spend_threshold"

export interface NotificationPreference {
  readonly event: NotificationEvent
  readonly email: boolean
  readonly slack: boolean
}

/** An actor a user keeps at hand: its address within one environment of one project. */
export interface PinnedActor {
  readonly projectId: string
  readonly environment: EnvironmentName
  readonly address: string
}

/** One row of an organization's audit log. */
export interface AuditEntry {
  readonly id: string
  readonly at: DateTime.Utc
  readonly actor: {
    readonly kind: AuditActorKind
    readonly id: string
    readonly name: string | null
  }
  readonly action: string
  readonly target: {
    readonly type: string
    readonly id: string | null
    readonly name: string | null
  }
  readonly ipAddress: string | null
}

/** A page of audit entries, newest first; `nextCursor` is null on the last page. */
export interface AuditPage {
  readonly items: ReadonlyArray<AuditEntry>
  readonly nextCursor: string | null
}

/** The organization has no such project; a project of another organization is indistinguishable. */
export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()("ProjectNotFound", {
  projectId: Schema.String,
}) {}

/** The project has no such environment, or the project is not the organization's. */
export class EnvironmentNotFound extends Schema.TaggedError<EnvironmentNotFound>()(
  "EnvironmentNotFound",
  { projectId: Schema.String, name: Schema.String },
) {}

/** The organization already has a project with this slug. */
export class ProjectSlugTaken extends Schema.TaggedError<ProjectSlugTaken>()("ProjectSlugTaken", {
  slug: Schema.String,
}) {}

/** The project already has an environment with this name. */
export class EnvironmentNameTaken extends Schema.TaggedError<EnvironmentNameTaken>()(
  "EnvironmentNameTaken",
  { name: Schema.String },
) {}

/** The project still has an environment with a current deployment, so it cannot be deleted. */
export class ProjectInUse extends Schema.TaggedError<ProjectInUse>()("ProjectInUse", {
  projectId: Schema.String,
}) {}

/** The environment has a current deployment, so it cannot be deleted. */
export class EnvironmentInUse extends Schema.TaggedError<EnvironmentInUse>()("EnvironmentInUse", {
  projectId: Schema.String,
  name: Schema.String,
}) {}

/** A page cursor this repository did not issue. */
export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()("InvalidCursor", {
  cursor: Schema.String,
}) {}

/** Client keys name one command within an environment, independently of a deployment. */
export interface CommandKey {
  readonly organizationId: string
  readonly projectId: string
  readonly environment: string
  readonly address: string
  readonly command: string
  readonly commandId: string
}

/** An active assignment references the runner receipt; expiry leaves only a key tombstone. */
export interface CommandAssignment {
  readonly commandId: string | null
  readonly payloadHash: string | null
  readonly expiresAt: number
  readonly expired: boolean
}

const canonicalJson = (value: Schema.Json): string => {
  if (!Predicate.isObject(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const object = value as { readonly [key: string]: Schema.Json }
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
    .join(",")}}`
}

/** Hashes JSON semantics rather than object insertion order, without retaining request contents. */
export const commandPayloadHash = (value: Schema.Json) =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex")

const commandKeyHash = (key: string) =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(key)).digest("hex")

const COMMAND_SWEEP_ROWS = 1000

/**
 * The control plane's own durable records: projects, environments, per-user
 * preferences and the audit log. Every operation names the organization (and
 * the user, for preferences) in its SQL, so another organization's rows are
 * never read or written. A project or environment mutation and its audit
 * entry commit in one transaction; preferences belong to one user and are not
 * audited. A database failure is a defect.
 */
export class Repository extends Context.Service<
  Repository,
  {
    /** Reads active receipt references or expired tombstones using the database clock. */
    readonly findCommand: (input: CommandKey) => Effect.Effect<CommandAssignment | undefined>
    /** A concurrent first send keeps the winner's immutable receipt reference, hash and expiry. */
    readonly assignCommand: (
      input: CommandKey & {
        readonly payloadHash: string
        readonly mintedCommandId: string
        readonly expiresAt: number
      },
    ) => Effect.Effect<CommandAssignment>
    /** Clears at most 1,000 expired assignments and prunes at most 1,000 30-day tombstones. */
    readonly sweepCommands: Effect.Effect<{
      readonly expired: number
      readonly pruned: number
    }>
    /** The organization's projects, oldest first. */
    readonly listProjects: (input: {
      readonly organizationId: string
    }) => Effect.Effect<ReadonlyArray<Project>>
    readonly getProject: (input: {
      readonly organizationId: string
      readonly projectId: string
    }) => Effect.Effect<Project, ProjectNotFound>
    /**
     * Creates the project with status `empty` and its `production`, `staging`
     * and `dev` environments, and records `project.create`, all in one
     * transaction.
     */
    readonly createProject: (
      input: Audited & {
        readonly name: string
        readonly slug: string
        readonly homeRegion: string
      },
    ) => Effect.Effect<Project, ProjectSlugTaken>
    /** Changes the name or slug and records `project.update`; with no change it records nothing. */
    readonly updateProject: (
      input: Audited & {
        readonly projectId: string
        readonly name?: string | undefined
        readonly slug?: string | undefined
      },
    ) => Effect.Effect<Project, ProjectNotFound | ProjectSlugTaken>
    /**
     * Deletes the project, its environments and every user's pins to them, and
     * records `project.delete`. A deleted project is not restored.
     */
    readonly deleteProject: (
      input: Audited & { readonly projectId: string },
    ) => Effect.Effect<void, ProjectNotFound | ProjectInUse>
    /** The project's environments: production, staging, then dev. */
    readonly listEnvironments: (input: {
      readonly organizationId: string
      readonly projectId: string
    }) => Effect.Effect<ReadonlyArray<Environment>, ProjectNotFound>
    readonly getEnvironment: (input: {
      readonly organizationId: string
      readonly projectId: string
      readonly name: EnvironmentName
    }) => Effect.Effect<Environment, EnvironmentNotFound>
    /** Creates an environment the project lacks (after a delete) and records `environment.create`. */
    readonly createEnvironment: (
      input: Audited & { readonly projectId: string; readonly name: EnvironmentName },
    ) => Effect.Effect<Environment, ProjectNotFound | EnvironmentNameTaken>
    /** Deletes the environment and every user's pins to it, and records `environment.delete`. */
    readonly deleteEnvironment: (
      input: Audited & { readonly projectId: string; readonly name: EnvironmentName },
    ) => Effect.Effect<void, EnvironmentNotFound | EnvironmentInUse>
    /** The user's settings; defaults until first changed. They follow the user across organizations. */
    readonly getPreferences: (input: { readonly userId: string }) => Effect.Effect<Preferences>
    /** Changes only the fields given and returns the result. */
    readonly updatePreferences: (input: {
      readonly userId: string
      readonly changes: Partial<Preferences>
    }) => Effect.Effect<Preferences>
    /** One entry per event; email is on and Slack off until changed. */
    readonly getNotifications: (input: {
      readonly userId: string
    }) => Effect.Effect<ReadonlyArray<NotificationPreference>>
    /** Replaces the entries given, leaves the other events alone and returns all of them. */
    readonly updateNotifications: (input: {
      readonly userId: string
      readonly changes: ReadonlyArray<NotificationPreference>
    }) => Effect.Effect<ReadonlyArray<NotificationPreference>>
    /** The user's pinned actors in pin order, optionally only those of one project and environment. */
    readonly listPinnedActors: (input: {
      readonly userId: string
      readonly projectId?: string | undefined
      readonly environment?: EnvironmentName | undefined
    }) => Effect.Effect<ReadonlyArray<PinnedActor>>
    /**
     * Appends the pin unless it is already there. The environment must belong
     * to `organizationId`, which the caller has established from the project.
     */
    readonly pinActor: (
      input: PinnedActor & { readonly organizationId: string; readonly userId: string },
    ) => Effect.Effect<ReadonlyArray<PinnedActor>, EnvironmentNotFound>
    readonly unpinActor: (
      input: PinnedActor & { readonly userId: string },
    ) => Effect.Effect<ReadonlyArray<PinnedActor>>
    /** Appends an entry for an action that happened elsewhere, such as an API key being created. */
    readonly recordAudit: (
      input: Audited & { readonly action: string; readonly target: AuditTarget },
    ) => Effect.Effect<AuditEntry>
    /** Runs inside the lifecycle turn: pointer, project status and audit share its fenced transaction. */
    readonly activateDeployment: (
      input: Audited & {
        readonly projectId: string
        readonly environment: EnvironmentName
        readonly deploymentId: string
        readonly previousDeploymentId: string | null
      },
    ) => Effect.Effect<boolean>
    /**
     * The organization's entries, newest first, optionally only one action or
     * one actor; `cursor` is a previous page's `nextCursor`.
     */
    readonly listAudit: (input: {
      readonly organizationId: string
      readonly action?: string | undefined
      readonly actorId?: string | undefined
      readonly limit?: number | undefined
      readonly cursor?: string | undefined
    }) => Effect.Effect<AuditPage, InvalidCursor>
  }
>()("@akter/api/repository") {}

/**
 * Serializes concurrent starts: `CREATE TABLE IF NOT EXISTS` alone races
 * when two processes create the same table at once.
 */
const MIGRATION_LOCK = 6_511_265_001

const migrations: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS cloud_project (
    id text PRIMARY KEY DEFAULT 'prj_' || replace(gen_random_uuid()::text, '-', ''),
    organization_id text NOT NULL CHECK (organization_id <> ''),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    slug text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
    status text NOT NULL DEFAULT 'empty' CHECK (status IN ('empty', 'live', 'deploying', 'failed')),
    home_region text NOT NULL CHECK (home_region <> ''),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, slug),
    UNIQUE (id, organization_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_environment (
    organization_id text NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL CHECK (name IN ('production', 'staging', 'dev')),
    current_deployment_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, name),
    FOREIGN KEY (project_id, organization_id) REFERENCES cloud_project (id, organization_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_preference (
    user_id text PRIMARY KEY CHECK (user_id <> ''),
    default_environment text NOT NULL CHECK (default_environment IN ('production', 'staging', 'dev')),
    open_actor_links_in_new_tab boolean NOT NULL,
    time_zone text NOT NULL CHECK (time_zone <> ''),
    pause_live_tail_on_scroll boolean NOT NULL,
    show_replayed_commands boolean NOT NULL,
    theme text NOT NULL CHECK (theme IN ('light', 'dark', 'system')),
    notifications jsonb NOT NULL CHECK (jsonb_typeof(notifications) = 'object'),
    pinned_actors jsonb NOT NULL CHECK (jsonb_typeof(pinned_actors) = 'array'),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id text NOT NULL CHECK (organization_id <> ''),
    actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'api-key')),
    actor_id text NOT NULL CHECK (actor_id <> ''),
    actor_name text,
    action text NOT NULL CHECK (action <> ''),
    target_type text NOT NULL CHECK (target_type <> ''),
    target_id text,
    target_name text,
    ip text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_audit_organization_idx ON cloud_audit (organization_id, id DESC)`,
  `CREATE TABLE IF NOT EXISTS cloud_command_idempotency (
    organization_id text NOT NULL CHECK (organization_id <> ''),
    project_id text NOT NULL CHECK (project_id <> ''),
    environment text NOT NULL CHECK (environment <> ''),
    address text NOT NULL CHECK (address <> ''),
    command text NOT NULL CHECK (command <> ''),
    key_hash text NOT NULL,
    command_id text CHECK (command_id <> ''),
    payload_hash text,
    expires_at_ms bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, project_id, environment, address, command, key_hash),
    UNIQUE (command_id)
  )`,
]

const DEFAULT_PREFERENCES: Preferences = {
  defaultEnvironment: "production",
  openActorLinksInNewTab: false,
  timeZone: "UTC",
  pauseLiveTailOnScroll: true,
  showReplayedCommands: false,
  theme: "system",
}

const NOTIFICATION_EVENTS: ReadonlyArray<NotificationEvent> = [
  "deploy_failed",
  "dead_letter",
  "spend_threshold",
]

/** The environments every project starts with, in the order they are listed. */
const ENVIRONMENT_ORDER = "ARRAY['production', 'staging', 'dev']"

const isUniqueViolation = (error: unknown): error is SqlError.SqlError =>
  SqlError.isSqlError(error) && Predicate.isTagged(error.reason, "UniqueViolation")

const DEFAULT_AUDIT_PAGE = 50

const MAX_AUDIT_PAGE = 100

interface ProjectRow {
  readonly id: string
  readonly organization_id: string
  readonly name: string
  readonly slug: string
  readonly status: ProjectStatus
  readonly home_region: string
  readonly created_at: Date
}

interface EnvironmentRow {
  readonly name: EnvironmentName
  readonly project_id: string
  readonly current_deployment_id: string | null
}

interface PreferenceRow {
  readonly default_environment: EnvironmentName
  readonly open_actor_links_in_new_tab: boolean
  readonly time_zone: string
  readonly pause_live_tail_on_scroll: boolean
  readonly show_replayed_commands: boolean
  readonly theme: Theme
}

interface AuditRow {
  readonly id: string
  readonly actor_kind: AuditActorKind
  readonly actor_id: string
  readonly actor_name: string | null
  readonly action: string
  readonly target_type: string
  readonly target_id: string | null
  readonly target_name: string | null
  readonly ip: string | null
  readonly created_at: Date
}

const project = (row: ProjectRow): Project => ({
  id: row.id,
  organizationId: row.organization_id,
  name: row.name,
  slug: row.slug,
  status: row.status,
  homeRegion: row.home_region,
  createdAt: DateTime.fromDateUnsafe(row.created_at),
})

const environment = (row: EnvironmentRow): Environment => ({
  name: row.name,
  projectId: row.project_id,
  currentDeploymentId: row.current_deployment_id,
})

const preferences = (row: PreferenceRow): Preferences => ({
  defaultEnvironment: row.default_environment,
  openActorLinksInNewTab: row.open_actor_links_in_new_tab,
  timeZone: row.time_zone,
  pauseLiveTailOnScroll: row.pause_live_tail_on_scroll,
  showReplayedCommands: row.show_replayed_commands,
  theme: row.theme,
})

const auditEntry = (row: AuditRow): AuditEntry => ({
  id: row.id,
  at: DateTime.fromDateUnsafe(row.created_at),
  actor: { kind: row.actor_kind, id: row.actor_id, name: row.actor_name },
  action: row.action,
  target: { type: row.target_type, id: row.target_id, name: row.target_name },
  ipAddress: row.ip,
})

/**
 * `Repository` over the control-plane database. Building the layer applies
 * the `cloud_*` migrations, which are idempotent and safe to run from several
 * processes at once.
 */
export const RepositoryLive = Layer.effect(
  Repository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`
        for (const statement of migrations) yield* sql.unsafe(statement)
        const legacy = yield* sql`
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'cloud_command_idempotency'
            AND column_name = 'payload'
        `
        if (legacy.length > 0) {
          yield* sql`LOCK TABLE cloud_command_idempotency IN ACCESS EXCLUSIVE MODE`
          yield* sql`ALTER TABLE cloud_command_idempotency
            ADD COLUMN IF NOT EXISTS key_hash text,
            ADD COLUMN IF NOT EXISTS payload_hash text,
            ADD COLUMN IF NOT EXISTS expires_at_ms bigint`
          for (;;) {
            const rows = yield* sql<CommandKey & { payload: Schema.Json; mintedCommandId: string }>`
              SELECT organization_id AS "organizationId", project_id AS "projectId",
                environment, address, command, idempotency_key AS "commandId",
                command_id AS "mintedCommandId", payload
              FROM cloud_command_idempotency WHERE key_hash IS NULL LIMIT ${COMMAND_SWEEP_ROWS}
            `
            if (rows.length === 0) break
            for (const row of rows) {
              const expiresAt = Number(row.mintedCommandId.split(".")[2])
              if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)
                return yield* Effect.die(new Error("An existing command assignment has no expiry"))
              yield* sql`UPDATE cloud_command_idempotency SET
                key_hash = ${commandKeyHash(row.commandId)},
                payload_hash = ${commandPayloadHash(row.payload)}, expires_at_ms = ${expiresAt}
                WHERE organization_id = ${row.organizationId} AND project_id = ${row.projectId}
                  AND environment = ${row.environment} AND address = ${row.address}
                  AND command = ${row.command} AND idempotency_key = ${row.commandId}`
            }
          }
          yield* sql`ALTER TABLE cloud_command_idempotency
            DROP CONSTRAINT cloud_command_idempotency_pkey,
            DROP COLUMN idempotency_key, DROP COLUMN payload,
            ALTER COLUMN command_id DROP NOT NULL,
            ALTER COLUMN key_hash SET NOT NULL, ALTER COLUMN expires_at_ms SET NOT NULL,
            ADD PRIMARY KEY (organization_id, project_id, environment, address, command, key_hash)`
        }
        yield* sql`CREATE INDEX IF NOT EXISTS cloud_command_idempotency_active_expiry_idx
          ON cloud_command_idempotency (expires_at_ms)
          WHERE command_id IS NOT NULL OR payload_hash IS NOT NULL`
        yield* sql`CREATE INDEX IF NOT EXISTS cloud_command_idempotency_tombstone_expiry_idx
          ON cloud_command_idempotency (expires_at_ms)
          WHERE command_id IS NULL AND payload_hash IS NULL`
      }),
    )

    const dieOnSql = <A, E, R>(self: Effect.Effect<A, E | SqlError.SqlError, R>) =>
      self.pipe(Effect.catchIf(SqlError.isSqlError, Effect.die))

    const insertAudit = (
      input: Audited & { readonly action: string; readonly target: AuditTarget },
    ) =>
      sql<AuditRow>`
        INSERT INTO cloud_audit (organization_id, actor_kind, actor_id, actor_name, action,
                                 target_type, target_id, target_name, ip)
        VALUES (${input.organizationId}, ${input.actor.kind}, ${input.actor.id},
                ${input.actor.name ?? null}, ${input.action}, ${input.target.type},
                ${input.target.id ?? null}, ${input.target.name ?? null}, ${input.ip ?? null})
        RETURNING id::text AS id, actor_kind, actor_id, actor_name, action, target_type, target_id,
                  target_name, ip, created_at
      `.pipe(Effect.map(([row]) => auditEntry(row!)))

    const projectExists = (organizationId: string, projectId: string) =>
      sql`
        SELECT 1 FROM cloud_project WHERE organization_id = ${organizationId} AND id = ${projectId}
      `.pipe(Effect.map((rows) => rows.length > 0))

    const ensurePreferences = (userId: string) =>
      sql`
        INSERT INTO cloud_preference (
          user_id, default_environment, open_actor_links_in_new_tab, time_zone,
          pause_live_tail_on_scroll, show_replayed_commands, theme, notifications, pinned_actors
        )
        VALUES (
          ${userId}, ${DEFAULT_PREFERENCES.defaultEnvironment},
          ${DEFAULT_PREFERENCES.openActorLinksInNewTab}, ${DEFAULT_PREFERENCES.timeZone},
          ${DEFAULT_PREFERENCES.pauseLiveTailOnScroll}, ${DEFAULT_PREFERENCES.showReplayedCommands},
          ${DEFAULT_PREFERENCES.theme}, '{}'::jsonb, '[]'::jsonb
        )
        ON CONFLICT (user_id) DO NOTHING
      `

    const notificationsOf = (stored: Record<string, { email: boolean; slack: boolean }>) =>
      NOTIFICATION_EVENTS.map((event): NotificationPreference => ({
        event,
        email: stored[event]?.email ?? true,
        slack: stored[event]?.slack ?? false,
      }))

    const sweepCommands = sql
      .withTransaction(
        Effect.gen(function* () {
          const expired = yield* sql`
            WITH candidates AS (
              SELECT ctid FROM cloud_command_idempotency
              WHERE expires_at_ms <= extract(epoch FROM statement_timestamp()) * 1000
                AND (command_id IS NOT NULL OR payload_hash IS NOT NULL)
              ORDER BY expires_at_ms LIMIT ${COMMAND_SWEEP_ROWS} FOR UPDATE SKIP LOCKED
            )
            UPDATE cloud_command_idempotency SET command_id = NULL, payload_hash = NULL
            WHERE ctid IN (SELECT ctid FROM candidates)
              AND expires_at_ms <= extract(epoch FROM statement_timestamp()) * 1000
            RETURNING 1
          `
          const pruned = yield* sql`
            WITH candidates AS (
              SELECT ctid FROM cloud_command_idempotency
              WHERE expires_at_ms < extract(epoch FROM statement_timestamp() - interval '30 days') * 1000
                AND command_id IS NULL AND payload_hash IS NULL
              ORDER BY expires_at_ms LIMIT ${COMMAND_SWEEP_ROWS} FOR UPDATE SKIP LOCKED
            )
            DELETE FROM cloud_command_idempotency WHERE ctid IN (SELECT ctid FROM candidates)
              AND expires_at_ms < extract(epoch FROM statement_timestamp() - interval '30 days') * 1000
              AND command_id IS NULL AND payload_hash IS NULL
            RETURNING 1
          `
          return { expired: expired.length, pruned: pruned.length }
        }),
      )
      .pipe(Effect.orDie)

    return {
      sweepCommands,
      findCommand: (input) =>
        sql<CommandAssignment>`
          SELECT CASE WHEN expires_at_ms > extract(epoch FROM clock_timestamp()) * 1000
              THEN command_id END AS "commandId",
            CASE WHEN expires_at_ms > extract(epoch FROM clock_timestamp()) * 1000
              THEN payload_hash END AS "payloadHash",
            expires_at_ms::float8 AS "expiresAt",
            expires_at_ms <= extract(epoch FROM clock_timestamp()) * 1000 AS expired
          FROM cloud_command_idempotency
          WHERE organization_id = ${input.organizationId} AND project_id = ${input.projectId}
            AND environment = ${input.environment} AND address = ${input.address}
            AND command = ${input.command} AND key_hash = ${commandKeyHash(input.commandId)}
        `.pipe(
          Effect.map(([row]) => row),
          Effect.orDie,
        ),
      assignCommand: (input) =>
        Effect.gen(function* () {
          const [row] = yield* sql<CommandAssignment>`
            INSERT INTO cloud_command_idempotency (
              organization_id, project_id, environment, address, command,
              key_hash, command_id, payload_hash, expires_at_ms
            ) VALUES (
              ${input.organizationId}, ${input.projectId}, ${input.environment},
              ${input.address}, ${input.command}, ${commandKeyHash(input.commandId)},
              ${input.mintedCommandId}, ${input.payloadHash}, ${input.expiresAt}
            )
            ON CONFLICT (organization_id, project_id, environment, address, command, key_hash)
            DO UPDATE SET key_hash = cloud_command_idempotency.key_hash
            RETURNING CASE WHEN expires_at_ms > extract(epoch FROM clock_timestamp()) * 1000
                THEN command_id END AS "commandId",
              CASE WHEN expires_at_ms > extract(epoch FROM clock_timestamp()) * 1000
                THEN payload_hash END AS "payloadHash",
              expires_at_ms::float8 AS "expiresAt",
              expires_at_ms <= extract(epoch FROM clock_timestamp()) * 1000 AS expired
          `
          if (row === undefined)
            return yield* Effect.die(new Error("Command assignment is missing"))
          return row
        }).pipe(Effect.orDie),
      activateDeployment: (input) =>
        Effect.gen(function* () {
          if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
            return yield* Effect.die(
              new Error("Deployment activation requires its lifecycle transaction"),
            )
          const changed =
            yield* sql`UPDATE cloud_environment SET current_deployment_id = ${input.deploymentId} WHERE organization_id = ${input.organizationId} AND project_id = ${input.projectId} AND name = ${input.environment} AND current_deployment_id IS NOT DISTINCT FROM ${input.previousDeploymentId} RETURNING project_id`
          if (changed.length !== 1) return false
          yield* sql`UPDATE cloud_project SET status = 'live' WHERE id = ${input.projectId} AND organization_id = ${input.organizationId}`
          yield* insertAudit({
            ...input,
            action: "deployment.live",
            target: { type: "deployment", id: input.deploymentId },
          })
          return true
        }).pipe(Effect.orDie),
      listProjects: ({ organizationId }) =>
        sql<ProjectRow>`
          SELECT id, organization_id, name, slug, status, home_region, created_at FROM cloud_project
          WHERE organization_id = ${organizationId}
          ORDER BY created_at, id
        `.pipe(
          Effect.map((rows) => rows.map(project)),
          dieOnSql,
        ),

      getProject: ({ organizationId, projectId }) =>
        sql<ProjectRow>`
          SELECT id, organization_id, name, slug, status, home_region, created_at FROM cloud_project
          WHERE organization_id = ${organizationId} AND id = ${projectId}
        `.pipe(
          Effect.flatMap(([row]) =>
            row === undefined
              ? Effect.fail(ProjectNotFound.make({ projectId }))
              : Effect.succeed(project(row)),
          ),
          dieOnSql,
        ),

      createProject: (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const [row] = yield* sql<ProjectRow>`
                INSERT INTO cloud_project (organization_id, name, slug, home_region)
                VALUES (${input.organizationId}, ${input.name}, ${input.slug}, ${input.homeRegion})
                ON CONFLICT (organization_id, slug) DO NOTHING
                RETURNING id, organization_id, name, slug, status, home_region, created_at
              `
              if (row === undefined) return yield* ProjectSlugTaken.make({ slug: input.slug })

              yield* sql`
                INSERT INTO cloud_environment (organization_id, project_id, name)
                SELECT ${input.organizationId}, ${row.id}, name
                FROM unnest(${sql.literal(ENVIRONMENT_ORDER)}) AS environment(name)
              `
              yield* insertAudit({
                ...input,
                action: "project.create",
                target: { type: "project", id: row.id, name: row.name },
              })

              return project(row)
            }),
          )
          .pipe(dieOnSql),

      updateProject: (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              if (input.name === undefined && input.slug === undefined) {
                const [current] = yield* sql<ProjectRow>`
                  SELECT id, organization_id, name, slug, status, home_region, created_at
                  FROM cloud_project
                  WHERE organization_id = ${input.organizationId} AND id = ${input.projectId}
                `
                if (current === undefined) {
                  return yield* ProjectNotFound.make({ projectId: input.projectId })
                }

                return project(current)
              }

              const [row] = yield* sql<ProjectRow>`
                UPDATE cloud_project
                SET name = coalesce(${input.name ?? null}, name),
                    slug = coalesce(${input.slug ?? null}, slug)
                WHERE organization_id = ${input.organizationId} AND id = ${input.projectId}
                RETURNING id, organization_id, name, slug, status, home_region, created_at
              `
              if (row === undefined)
                return yield* ProjectNotFound.make({ projectId: input.projectId })

              yield* insertAudit({
                ...input,
                action: "project.update",
                target: { type: "project", id: row.id, name: row.name },
              })

              return project(row)
            }),
          )
          .pipe(
            Effect.catchIf(isUniqueViolation, () =>
              Effect.fail(ProjectSlugTaken.make({ slug: input.slug ?? "" })),
            ),
            dieOnSql,
          ),

      deleteProject: (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const [row] = yield* sql<ProjectRow>`
                SELECT id, organization_id, name, slug, status, home_region, created_at
                FROM cloud_project
                WHERE organization_id = ${input.organizationId} AND id = ${input.projectId}
                FOR UPDATE
              `
              if (row === undefined)
                return yield* ProjectNotFound.make({ projectId: input.projectId })

              const deployed = yield* sql`
                SELECT 1 FROM cloud_environment
                WHERE project_id = ${input.projectId} AND current_deployment_id IS NOT NULL
              `
              if (deployed.length > 0)
                return yield* ProjectInUse.make({ projectId: input.projectId })

              yield* sql`DELETE FROM cloud_environment WHERE project_id = ${input.projectId}`
              yield* sql`
                UPDATE cloud_preference
                SET pinned_actors = (
                      SELECT coalesce(jsonb_agg(entry ORDER BY position), '[]'::jsonb)
                      FROM jsonb_array_elements(pinned_actors) WITH ORDINALITY AS pinned(entry, position)
                      WHERE entry ->> 'projectId' <> ${input.projectId}
                    )
                WHERE pinned_actors @> jsonb_build_array(jsonb_build_object('projectId', ${input.projectId}::text))
              `
              yield* sql`DELETE FROM cloud_project WHERE id = ${input.projectId}`
              yield* insertAudit({
                ...input,
                action: "project.delete",
                target: { type: "project", id: row.id, name: row.name },
              })
            }),
          )
          .pipe(dieOnSql),

      listEnvironments: ({ organizationId, projectId }) =>
        Effect.gen(function* () {
          const rows = yield* sql<EnvironmentRow>`
            SELECT name, project_id, current_deployment_id FROM cloud_environment
            WHERE organization_id = ${organizationId} AND project_id = ${projectId}
            ORDER BY array_position(${sql.literal(ENVIRONMENT_ORDER)}, name)
          `
          if (rows.length === 0 && !(yield* projectExists(organizationId, projectId))) {
            return yield* ProjectNotFound.make({ projectId })
          }

          return rows.map(environment)
        }).pipe(dieOnSql),

      getEnvironment: ({ organizationId, projectId, name }) =>
        sql<EnvironmentRow>`
          SELECT name, project_id, current_deployment_id FROM cloud_environment
          WHERE organization_id = ${organizationId} AND project_id = ${projectId} AND name = ${name}
        `.pipe(
          Effect.flatMap(([row]) =>
            row === undefined
              ? Effect.fail(EnvironmentNotFound.make({ projectId, name }))
              : Effect.succeed(environment(row)),
          ),
          dieOnSql,
        ),

      createEnvironment: (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const [row] = yield* sql<EnvironmentRow>`
                INSERT INTO cloud_environment (organization_id, project_id, name)
                SELECT organization_id, id, ${input.name} FROM cloud_project
                WHERE organization_id = ${input.organizationId} AND id = ${input.projectId}
                ON CONFLICT (project_id, name) DO NOTHING
                RETURNING name, project_id, current_deployment_id
              `
              if (row === undefined) {
                return (yield* projectExists(input.organizationId, input.projectId))
                  ? yield* EnvironmentNameTaken.make({ name: input.name })
                  : yield* ProjectNotFound.make({ projectId: input.projectId })
              }

              yield* insertAudit({
                ...input,
                action: "environment.create",
                target: {
                  type: "environment",
                  id: `${row.project_id}/${row.name}`,
                  name: row.name,
                },
              })

              return environment(row)
            }),
          )
          .pipe(dieOnSql),

      deleteEnvironment: (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const [row] = yield* sql<EnvironmentRow>`
                SELECT name, project_id, current_deployment_id FROM cloud_environment
                WHERE organization_id = ${input.organizationId} AND project_id = ${input.projectId}
                  AND name = ${input.name}
                FOR UPDATE
              `
              if (row === undefined) {
                return yield* EnvironmentNotFound.make({
                  projectId: input.projectId,
                  name: input.name,
                })
              }
              if (row.current_deployment_id !== null) {
                return yield* EnvironmentInUse.make({
                  projectId: input.projectId,
                  name: input.name,
                })
              }

              yield* sql`
                DELETE FROM cloud_environment WHERE project_id = ${input.projectId} AND name = ${input.name}
              `
              yield* sql`
                UPDATE cloud_preference
                SET pinned_actors = (
                      SELECT coalesce(jsonb_agg(entry ORDER BY position), '[]'::jsonb)
                      FROM jsonb_array_elements(pinned_actors) WITH ORDINALITY AS pinned(entry, position)
                      WHERE NOT (entry ->> 'projectId' = ${input.projectId}
                                 AND entry ->> 'environment' = ${input.name})
                    )
                WHERE pinned_actors @> jsonb_build_array(
                        jsonb_build_object('projectId', ${input.projectId}::text,
                                           'environment', ${input.name}::text))
              `
              yield* insertAudit({
                ...input,
                action: "environment.delete",
                target: {
                  type: "environment",
                  id: `${input.projectId}/${input.name}`,
                  name: input.name,
                },
              })
            }),
          )
          .pipe(dieOnSql),

      getPreferences: ({ userId }) =>
        sql<PreferenceRow>`
          SELECT default_environment, open_actor_links_in_new_tab, time_zone,
                 pause_live_tail_on_scroll, show_replayed_commands, theme
          FROM cloud_preference
          WHERE user_id = ${userId}
        `.pipe(
          Effect.map(([row]) => (row === undefined ? DEFAULT_PREFERENCES : preferences(row))),
          dieOnSql,
        ),

      updatePreferences: ({ userId, changes }) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* ensurePreferences(userId)
              const [row] = yield* sql<PreferenceRow>`
                UPDATE cloud_preference SET
                  default_environment = coalesce(${changes.defaultEnvironment ?? null}, default_environment),
                  open_actor_links_in_new_tab =
                    coalesce(${changes.openActorLinksInNewTab ?? null}, open_actor_links_in_new_tab),
                  time_zone = coalesce(${changes.timeZone ?? null}, time_zone),
                  pause_live_tail_on_scroll =
                    coalesce(${changes.pauseLiveTailOnScroll ?? null}, pause_live_tail_on_scroll),
                  show_replayed_commands =
                    coalesce(${changes.showReplayedCommands ?? null}, show_replayed_commands),
                  theme = coalesce(${changes.theme ?? null}, theme),
                  updated_at = now()
                WHERE user_id = ${userId}
                RETURNING default_environment, open_actor_links_in_new_tab, time_zone,
                          pause_live_tail_on_scroll, show_replayed_commands, theme
              `

              return preferences(row!)
            }),
          )
          .pipe(dieOnSql),

      getNotifications: ({ userId }) =>
        sql<{ readonly notifications: Record<string, { email: boolean; slack: boolean }> }>`
          SELECT notifications FROM cloud_preference
          WHERE user_id = ${userId}
        `.pipe(
          Effect.map(([row]) => notificationsOf(row?.notifications ?? {})),
          dieOnSql,
        ),

      updateNotifications: ({ userId, changes }) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* ensurePreferences(userId)
              for (const { event, email, slack } of changes) {
                yield* sql`
                  UPDATE cloud_preference
                  SET notifications = jsonb_set(
                        notifications, ARRAY[${event}::text],
                        jsonb_build_object('email', ${email}::boolean, 'slack', ${slack}::boolean)
                      ),
                      updated_at = now()
                  WHERE user_id = ${userId}
                `
              }
              const [row] = yield* sql<{
                readonly notifications: Record<string, { email: boolean; slack: boolean }>
              }>`
                SELECT notifications FROM cloud_preference
                WHERE user_id = ${userId}
              `

              return notificationsOf(row!.notifications)
            }),
          )
          .pipe(dieOnSql),

      listPinnedActors: ({ userId, projectId, environment: name }) =>
        sql<{ readonly pinned_actors: ReadonlyArray<PinnedActor> }>`
          SELECT pinned_actors FROM cloud_preference
          WHERE user_id = ${userId}
        `.pipe(
          Effect.map(([row]) =>
            (row?.pinned_actors ?? []).filter(
              (pin) =>
                (projectId === undefined || pin.projectId === projectId) &&
                (name === undefined || pin.environment === name),
            ),
          ),
          dieOnSql,
        ),

      pinActor: ({ organizationId, userId, projectId, environment: name, address }) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const environments = yield* sql`
                SELECT 1 FROM cloud_environment
                WHERE organization_id = ${organizationId} AND project_id = ${projectId}
                  AND name = ${name}
                FOR SHARE
              `
              if (environments.length === 0) {
                return yield* EnvironmentNotFound.make({ projectId, name })
              }

              yield* ensurePreferences(userId)
              const [row] = yield* sql<{ readonly pinned_actors: ReadonlyArray<PinnedActor> }>`
                UPDATE cloud_preference
                SET pinned_actors = CASE
                      WHEN pinned_actors @> jsonb_build_array(
                             jsonb_build_object('projectId', ${projectId}::text,
                                                'environment', ${name}::text,
                                                'address', ${address}::text))
                      THEN pinned_actors
                      ELSE pinned_actors || jsonb_build_array(
                             jsonb_build_object('projectId', ${projectId}::text,
                                                'environment', ${name}::text,
                                                'address', ${address}::text))
                    END,
                    updated_at = now()
                WHERE user_id = ${userId}
                RETURNING pinned_actors
              `

              return row!.pinned_actors
            }),
          )
          .pipe(dieOnSql),

      unpinActor: ({ userId, projectId, environment: name, address }) =>
        sql<{ readonly pinned_actors: ReadonlyArray<PinnedActor> }>`
          UPDATE cloud_preference
          SET pinned_actors = (
                SELECT coalesce(jsonb_agg(entry ORDER BY position), '[]'::jsonb)
                FROM jsonb_array_elements(pinned_actors) WITH ORDINALITY AS pinned(entry, position)
                WHERE entry <> jsonb_build_object('projectId', ${projectId}::text,
                                                  'environment', ${name}::text,
                                                  'address', ${address}::text)
              ),
              updated_at = now()
          WHERE user_id = ${userId}
          RETURNING pinned_actors
        `.pipe(
          Effect.map(([row]) => row?.pinned_actors ?? []),
          dieOnSql,
        ),

      recordAudit: (input) => insertAudit(input).pipe(dieOnSql),

      listAudit: ({ organizationId, action, actorId, limit, cursor }) =>
        Effect.gen(function* () {
          if (cursor !== undefined && !/^[0-9]{1,18}$/.test(cursor)) {
            return yield* InvalidCursor.make({ cursor })
          }

          const size = Math.min(Math.max(limit ?? DEFAULT_AUDIT_PAGE, 1), MAX_AUDIT_PAGE)
          const rows = yield* sql<AuditRow>`
            SELECT id::text AS id, actor_kind, actor_id, actor_name, action, target_type, target_id,
                   target_name, ip, created_at
            FROM cloud_audit
            WHERE organization_id = ${organizationId}
              ${action === undefined ? sql`` : sql`AND action = ${action}`}
              ${actorId === undefined ? sql`` : sql`AND actor_id = ${actorId}`}
              ${cursor === undefined ? sql`` : sql`AND id < ${cursor}::bigint`}
            ORDER BY cloud_audit.id DESC
            LIMIT ${size + 1}
          `
          const items = rows.slice(0, size).map(auditEntry)

          return { items, nextCursor: rows.length > size ? items[size - 1]!.id : null }
        }).pipe(dieOnSql),
    }
  }),
)

/** Runs the bounded command-key sweep once a minute for the API process lifetime. */
export const RepositoryRetentionLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const repository = yield* Repository
    yield* repository.sweepCommands.pipe(
      Effect.catchCause(() => Effect.logWarning("Command retention sweep failed")),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped,
    )
  }),
)
