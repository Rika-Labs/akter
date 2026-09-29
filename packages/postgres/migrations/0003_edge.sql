-- What the hosted edge reads: hosts, runners, hosted credentials, and its published keys.

-- A platform subdomain or verified custom domain, lowercase and without a port.
CREATE TABLE deployment_host (
  host text PRIMARY KEY CHECK (host = lower(host) AND host !~ ':'),
  deployment_id text NOT NULL REFERENCES deployment(id) ON DELETE CASCADE
);

CREATE INDEX deployment_host_deployment_idx ON deployment_host (deployment_id);

-- The runners the edge may forward to; any ready one in the tenant's home region will do.
CREATE TABLE deployment_runner (
  deployment_id text NOT NULL REFERENCES deployment(id) ON DELETE CASCADE,
  region text NOT NULL,
  url text NOT NULL,
  -- The runner's `Actor.serve` base path, where the edge pushes key-set refreshes. Client
  -- requests are forwarded with their own path, which already includes it.
  base_path text NOT NULL DEFAULT '' CHECK (base_path = '' OR base_path ~ '^/.*[^/]$'),
  ready boolean NOT NULL DEFAULT true,
  PRIMARY KEY (deployment_id, region, url)
);

-- Hosted API keys, stored as the SHA-256 of the key. A revoked key is refused from the
-- moment `revoked_at` commits.
CREATE TABLE hosted_api_key (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  deployment_id text NOT NULL REFERENCES deployment(id) ON DELETE CASCADE,
  tenant text NOT NULL CHECK (tenant ~ '^[A-Za-z0-9._:-]{1,128}$'),
  subject text NOT NULL CHECK (octet_length(subject) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX hosted_api_key_deployment_idx ON hosted_api_key (deployment_id);

-- A deployment's declarative JWT settings: the tenant is a claim or a fixed value, never code.
CREATE TABLE deployment_jwt (
  deployment_id text PRIMARY KEY REFERENCES deployment(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  audience text NOT NULL,
  jwks_url text NOT NULL,
  algorithms text[] NOT NULL DEFAULT ARRAY['RS256', 'ES256', 'EdDSA'],
  tenant_claim text,
  tenant_fixed text,
  subject_claim text NOT NULL DEFAULT 'sub',
  CHECK ((tenant_claim IS NULL) <> (tenant_fixed IS NULL))
);

-- The edge's public keys. Runners read the unrevoked ones as their key set; a key is
-- published before the edge signs with it and stays published until `expires_at`.
CREATE TABLE edge_key (
  kid text PRIMARY KEY,
  x text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
