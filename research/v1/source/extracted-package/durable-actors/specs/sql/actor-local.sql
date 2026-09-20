-- DESIGN REFERENCE ONLY. Not automatically applied by the scaffold.
-- Validate on the exact hosted libSQL endpoint before using in the runtime.
CREATE TABLE IF NOT EXISTS _da_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  incarnation TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch >= 0)
);
CREATE TABLE IF NOT EXISTS _da_commands (
  command_id TEXT PRIMARY KEY,
  payload_digest TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  actor_revision TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'rejected')),
  result_json TEXT NOT NULL,
  committed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS _da_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id TEXT NOT NULL UNIQUE,
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  delivered_at TEXT
);
-- A real turn must check the installed epoch under the same write transaction
-- as application changes and receipts. This DDL alone does not implement fencing.
