import { Database } from "@rikalabs/akter/runtime"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, type SqlError } from "effect/sql"

/** The project was never sent the archive a deployment names. */
export class SourceNotFound extends Schema.TaggedError<SourceNotFound>()("SourceNotFound", {
  digest: Schema.String,
}) {}

/** What a deployment is built from: its archive's bytes and the Dockerfile inside it. */
export interface DeploymentSource {
  readonly archive: Uint8Array
  readonly dockerfile: string
}

/**
 * Build contexts a CLI uploads, stored once per project under the SHA-256 of
 * their bytes, and which archive each deployment is built from. `builds` is
 * false on a control plane without a builder, which refuses uploads because
 * nothing would ever build them.
 */
export class Sources extends Context.Service<
  Sources,
  {
    readonly builds: boolean
    /** Stores `archive` for the project, once; the same bytes again answer the same digest. */
    readonly store: (input: {
      readonly organizationId: string
      readonly projectId: string
      readonly archive: Uint8Array
    }) => Effect.Effect<{ readonly digest: string; readonly sizeBytes: number }>
    /** Records that `deploymentId` is built from the project's archive `digest`. */
    readonly attach: (input: {
      readonly organizationId: string
      readonly projectId: string
      readonly deploymentId: string
      readonly digest: string
      readonly dockerfile: string
    }) => Effect.Effect<void, SourceNotFound>
    /** Gives a redeploy the source of the deployment it rebuilds, if that one had one. */
    readonly copy: (input: { readonly from: string; readonly to: string }) => Effect.Effect<void>
    /** The source `deploymentId` is built from; none for a deployment built from the builder's own context. */
    readonly forDeployment: (
      deploymentId: string,
    ) => Effect.Effect<Option.Option<DeploymentSource>, SqlError.SqlError>
  }
>()("@akter/api/sources") {}

/**
 * `Sources` over the control-plane database. An attachment is written before
 * the deployment it names is created, so the build job, which may run as soon
 * as the deployment exists, always finds it; one whose deployment is then
 * refused names an id that never exists and is never read.
 */
export const SourcesLive = (options: { readonly builds: boolean }) =>
  Layer.effect(
    Sources,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* Database.schemaChange(
        Effect.gen(function* () {
          yield* sql`CREATE TABLE IF NOT EXISTS cloud_source_archive (
    organization_id text NOT NULL CHECK (organization_id <> ''),
    project_id text NOT NULL CHECK (project_id <> ''),
    digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
    archive bytea NOT NULL,
    size_bytes integer NOT NULL CHECK (size_bytes = octet_length(archive)),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, digest)
  )`
          yield* sql`CREATE TABLE IF NOT EXISTS cloud_deployment_source (
    deployment_id text PRIMARY KEY CHECK (deployment_id <> ''),
    project_id text NOT NULL,
    digest text NOT NULL,
    dockerfile text NOT NULL CHECK (dockerfile <> ''),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, digest) REFERENCES cloud_source_archive (project_id, digest)
  )`
        }),
        499500503,
      ).pipe(Effect.orDie)

      return Sources.of({
        builds: options.builds,
        store: Effect.fnUntraced(function* ({ organizationId, projectId, archive }) {
          const digest = `sha256:${new Bun.CryptoHasher("sha256").update(archive).digest("hex")}`
          yield* sql`INSERT INTO cloud_source_archive (organization_id, project_id, digest, archive, size_bytes)
            VALUES (${organizationId}, ${projectId}, ${digest}, ${archive}, ${archive.byteLength})
            ON CONFLICT (project_id, digest) DO NOTHING`.pipe(Effect.orDie)
          return { digest, sizeBytes: archive.byteLength }
        }),
        attach: Effect.fnUntraced(function* (input) {
          const inserted = yield* sql<{
            deployment_id: string
          }>`INSERT INTO cloud_deployment_source (deployment_id, project_id, digest, dockerfile)
            SELECT ${input.deploymentId}, project_id, digest, ${input.dockerfile} FROM cloud_source_archive
            WHERE organization_id = ${input.organizationId} AND project_id = ${input.projectId} AND digest = ${input.digest}
            RETURNING deployment_id`.pipe(Effect.orDie)
          if (inserted.length === 0) return yield* SourceNotFound.make({ digest: input.digest })
        }),
        copy: ({ from, to }) =>
          sql`INSERT INTO cloud_deployment_source (deployment_id, project_id, digest, dockerfile)
            SELECT ${to}, project_id, digest, dockerfile FROM cloud_deployment_source WHERE deployment_id = ${from}`.pipe(
            Effect.asVoid,
            Effect.orDie,
          ),
        forDeployment: (deploymentId) =>
          sql<{ archive: Uint8Array; dockerfile: string }>`SELECT a.archive, s.dockerfile
            FROM cloud_deployment_source s
            JOIN cloud_source_archive a ON a.project_id = s.project_id AND a.digest = s.digest
            WHERE s.deployment_id = ${deploymentId}`.pipe(
            Effect.map((rows) => Option.fromNullishOr(rows[0])),
          ),
      })
    }),
  )
