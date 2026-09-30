-- Scale-to-zero: a deployment may run with no runners, and a request then asks for one.

-- Whether the edge asks for a runner when a region has none ready, instead of refusing at once.
ALTER TABLE deployment ADD COLUMN scale_to_zero boolean NOT NULL DEFAULT false;

-- A region of a scale-to-zero deployment that has no ready runner and has a request waiting.
-- The edge inserts or refreshes the row; the runner provider starts a runner, registers it in
-- `deployment_runner`, and deletes the row. Many edges asking at once leave one row.
CREATE TABLE runner_wake (
  deployment_id text NOT NULL REFERENCES deployment(id) ON DELETE CASCADE,
  region text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, region)
);
