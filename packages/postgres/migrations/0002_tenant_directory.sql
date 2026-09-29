-- Hosted deployments and the tenant directory: where each hosted tenant lives.
-- A tenant with no directory row lives in its deployment's primary region.
CREATE TABLE deployment (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  primary_region text NOT NULL CHECK (primary_region ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The TenantHome actor's owned table: the framework scopes routing_key, tenant_id,
-- and actor_id, and the edge reads it with plain SQL outside any turn.
CREATE TABLE tenant_directory (
  routing_key bigint NOT NULL,
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  deployment_id text NOT NULL REFERENCES deployment(id) ON DELETE CASCADE,
  tenant text NOT NULL CHECK (tenant ~ '^[A-Za-z0-9._:-]{1,128}$'),
  region text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'moving')),
  version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (routing_key, tenant_id, actor_id, deployment_id, tenant)
);

CREATE UNIQUE INDEX tenant_directory_home ON tenant_directory (deployment_id, tenant);

CREATE INDEX tenant_directory_version_idx ON tenant_directory (deployment_id, version);

CREATE SEQUENCE tenant_directory_version;

-- Every change takes a new version. The lock orders versions by commit, so a
-- reader that has seen version v has seen every committed change up to v, and
-- polling for rows above the highest version it holds never skips one.
CREATE FUNCTION tenant_directory_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(741902114);
  NEW.version := nextval('tenant_directory_version');
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_directory_stamp BEFORE INSERT OR UPDATE ON tenant_directory
  FOR EACH ROW EXECUTE FUNCTION tenant_directory_stamp();
