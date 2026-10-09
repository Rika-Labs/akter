# Cold-tier amendment: real-Postgres protocol model

**Scope:** design evidence for proposed [ADR 0114](../decisions/0114-cold-tier-admission-and-garbage.md), not a claim that ADR 0036 or its failure tests are implemented.

## What the model rejects

A collector that trusts an old garbage row without checking the current reference can delete an actor's only durable state. A collector that checks the reference but not the cold outbox can delete an upload still being retried. The model also rejects reclaiming a recent candidate just because it is currently unreferenced.

Two lease-separated attempts snapshot generation 41 and the same asymmetric state/blob bytes. Their deterministic immutable keys coincide. The replacement attempt flips first; the earlier attempt then sees an already-cold actor. Treating that abort as an unreference creates a garbage candidate that still names the live object. The age-only deletion is deliberately executed under a savepoint to demonstrate the unreadable pointer, then rolled back. The proposed abort predicate rejects that candidate, and the proposed collection predicates preserve the object even if a stale candidate exists.

An old object then rehydrates at time 4,000, just after a backup at 3,999. At time 5,000 its creation at 100 is past the collection window, but its latest unreference is not. Reconciliation that ignores the new garbage timestamp breaks that valid backup; this second deletion is also demonstrated under a rolled-back savepoint. Both proposed collection paths honor the latest unreference. At time 6,000 the interval has elapsed, but a retrying cold row still protects it; only after that row is gone is deletion eligible.

This is a sequential execution of a legal interleaving on real Postgres, using temporary tables for the generation, state, outbox, snapshots, garbage candidates, and object bytes. It does not run competing runner processes, network storage, compression, framework migrations, or runtime offload code. The restored-reference case reinstates the model's old generation/reference; it is not a whole-database backup/restore rehearsal. Those tests remain required for L.2.

## Reproduce

Run the SQL below with `psql -X -v ON_ERROR_STOP=1` against a disposable local/test Postgres database. All tables are temporary and the final rollback leaves no schema or data behind. Each observed result is `NOT NULL` with a `CHECK (observed)` constraint: a wrong result fails the command instead of just printing a suspicious value. The collection window is independently fixed at 1,500 ms; at time 5,000 its cutoff is 3,500, so timestamps 200 and 4,000 lie on opposite sides. At time 6,000 the cutoff is 4,500, and a recent candidate at 5,900 is still retained.

```sql
BEGIN;

CREATE TEMP TABLE cold_model_actor (
  actor_id text PRIMARY KEY,
  generation bigint NOT NULL,
  cold_ref text
);
CREATE TEMP TABLE cold_model_state (actor_id text PRIMARY KEY, value bytea NOT NULL);
CREATE TEMP TABLE cold_model_outbox (
  actor_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind = 'cold'),
  due_at_ms bigint NOT NULL,
  attempts integer NOT NULL
);
CREATE TEMP TABLE cold_model_snapshot (
  attempt text PRIMARY KEY,
  actor_id text NOT NULL,
  generation bigint NOT NULL,
  object_key text NOT NULL,
  value bytea NOT NULL
);
CREATE TEMP TABLE cold_model_object (
  object_key text PRIMARY KEY,
  actor_id text NOT NULL,
  value bytea NOT NULL,
  created_at_ms bigint NOT NULL
);
CREATE TEMP TABLE cold_model_garbage (
  actor_id text NOT NULL,
  object_key text PRIMARY KEY,
  unreferenced_at_ms bigint NOT NULL
);
CREATE TEMP TABLE cold_model_backup (cold_ref text NOT NULL, taken_at_ms bigint NOT NULL);
CREATE TEMP TABLE cold_model_clock (now_ms bigint NOT NULL, window_ms bigint NOT NULL);
CREATE TEMP TABLE cold_model_results (
  scenario text PRIMARY KEY,
  observed boolean NOT NULL CHECK (observed)
);

INSERT INTO cold_model_clock VALUES (5000, 1500);
INSERT INTO cold_model_actor VALUES ('vault-a', 41, NULL);
INSERT INTO cold_model_state VALUES
  ('vault-a', convert_to('{"version":1,"state":{"balance":73},"blob":[11,29,47]}', 'UTF8'));
INSERT INTO cold_model_outbox VALUES ('vault-a', 'cold', 0, 0);

UPDATE cold_model_outbox SET due_at_ms = 500, attempts = 1 WHERE due_at_ms <= 0;
INSERT INTO cold_model_snapshot
  SELECT 'A', a.actor_id, a.generation,
    'deployment/tenant/Vault/91/' || encode(sha256(convert_to(a.actor_id, 'UTF8')), 'hex')
      || '/' || a.generation || '-' || encode(sha256(s.value), 'hex'), s.value
  FROM cold_model_actor a JOIN cold_model_state s USING (actor_id);
INSERT INTO cold_model_object
  SELECT object_key, actor_id, value, 100 FROM cold_model_snapshot WHERE attempt = 'A';

UPDATE cold_model_outbox SET due_at_ms = 900, attempts = 2 WHERE due_at_ms <= 501;
INSERT INTO cold_model_snapshot
  SELECT 'B', a.actor_id, a.generation,
    'deployment/tenant/Vault/91/' || encode(sha256(convert_to(a.actor_id, 'UTF8')), 'hex')
      || '/' || a.generation || '-' || encode(sha256(s.value), 'hex'), s.value
  FROM cold_model_actor a JOIN cold_model_state s USING (actor_id);
INSERT INTO cold_model_object
  SELECT object_key, actor_id, value, 100 FROM cold_model_snapshot WHERE attempt = 'B'
  ON CONFLICT (object_key) DO NOTHING;
INSERT INTO cold_model_results SELECT 'same_generation_reuses_verified_key',
  (SELECT count(*) = 2 AND count(DISTINCT object_key) = 1 FROM cold_model_snapshot)
  AND NOT EXISTS (
    SELECT 1 FROM cold_model_snapshot s JOIN cold_model_object o USING (object_key)
    WHERE sha256(s.value) <> sha256(o.value)
  );

SELECT generation, cold_ref FROM cold_model_actor WHERE actor_id = 'vault-a' FOR UPDATE;
UPDATE cold_model_actor a SET cold_ref = s.object_key
  FROM cold_model_snapshot s WHERE s.attempt = 'B' AND a.actor_id = s.actor_id
    AND a.generation = s.generation AND a.cold_ref IS NULL;
DELETE FROM cold_model_state WHERE actor_id = 'vault-a';
DELETE FROM cold_model_outbox WHERE actor_id = 'vault-a' AND due_at_ms = 900;
INSERT INTO cold_model_results SELECT 'replacement_flip_keeps_one_readable_source',
  NOT EXISTS (SELECT 1 FROM cold_model_state)
  AND NOT EXISTS (SELECT 1 FROM cold_model_outbox)
  AND EXISTS (SELECT 1 FROM cold_model_actor a JOIN cold_model_object o ON o.object_key = a.cold_ref);
INSERT INTO cold_model_backup SELECT cold_ref, 3999 FROM cold_model_actor;

SELECT generation, cold_ref FROM cold_model_actor WHERE actor_id = 'vault-a' FOR UPDATE;
WITH recorded AS (
  INSERT INTO cold_model_garbage
    SELECT s.actor_id, s.object_key, 200 FROM cold_model_snapshot s
    JOIN cold_model_actor a USING (actor_id)
    WHERE s.attempt = 'A' AND a.cold_ref IS DISTINCT FROM s.object_key
    RETURNING object_key
)
INSERT INTO cold_model_results SELECT 'abort_does_not_mark_current_reference', count(*) = 0 FROM recorded;

INSERT INTO cold_model_garbage
  SELECT actor_id, object_key, 200 FROM cold_model_snapshot WHERE attempt = 'A';
SAVEPOINT age_only;
DELETE FROM cold_model_object o USING cold_model_garbage g
  WHERE o.object_key = g.object_key AND g.unreferenced_at_ms < 3500;
INSERT INTO cold_model_results SELECT 'age_only_deletion_breaks_cold_reference',
  EXISTS (SELECT 1 FROM cold_model_actor a
    WHERE a.cold_ref IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM cold_model_object o WHERE o.object_key = a.cold_ref
    ));
SELECT * FROM cold_model_results WHERE scenario = 'age_only_deletion_breaks_cold_reference';
ROLLBACK TO SAVEPOINT age_only;

CREATE TEMP VIEW cold_model_deletable AS
  SELECT g.* FROM cold_model_garbage g
  WHERE g.unreferenced_at_ms < (SELECT now_ms - window_ms FROM cold_model_clock)
    AND NOT EXISTS (SELECT 1 FROM cold_model_actor a
      WHERE a.actor_id = g.actor_id AND a.cold_ref = g.object_key)
    AND NOT EXISTS (SELECT 1 FROM cold_model_outbox o
      WHERE o.actor_id = g.actor_id AND o.kind = 'cold');
CREATE TEMP VIEW cold_model_reconciliable AS
  SELECT o.* FROM cold_model_object o LEFT JOIN cold_model_garbage g USING (object_key)
  WHERE coalesce(g.unreferenced_at_ms, o.created_at_ms)
      < (SELECT now_ms - window_ms FROM cold_model_clock)
    AND NOT EXISTS (SELECT 1 FROM cold_model_actor a
      WHERE a.actor_id = o.actor_id AND a.cold_ref = o.object_key)
    AND NOT EXISTS (SELECT 1 FROM cold_model_outbox pending
      WHERE pending.actor_id = o.actor_id AND pending.kind = 'cold');
WITH deleted AS (
  DELETE FROM cold_model_object o USING cold_model_deletable g
    WHERE o.object_key = g.object_key RETURNING o.object_key
)
INSERT INTO cold_model_results SELECT 'reference_gate_preserves_live_object', count(*) = 0 FROM deleted;

UPDATE cold_model_actor SET generation = 42, cold_ref = NULL WHERE actor_id = 'vault-a';
INSERT INTO cold_model_state SELECT actor_id, value FROM cold_model_snapshot WHERE attempt = 'B';
UPDATE cold_model_actor a SET generation = 41, cold_ref = s.object_key
  FROM cold_model_snapshot s WHERE s.attempt = 'A' AND a.actor_id = s.actor_id;
DELETE FROM cold_model_state WHERE actor_id = 'vault-a';
INSERT INTO cold_model_results SELECT 'restored_reference_is_not_garbage',
  NOT EXISTS (SELECT 1 FROM cold_model_deletable)
  AND EXISTS (SELECT 1 FROM cold_model_actor a JOIN cold_model_object o ON o.object_key = a.cold_ref);

UPDATE cold_model_actor SET generation = 42, cold_ref = NULL WHERE actor_id = 'vault-a';
INSERT INTO cold_model_state SELECT actor_id, value FROM cold_model_snapshot WHERE attempt = 'B';
INSERT INTO cold_model_garbage
  SELECT actor_id, object_key, 4000 FROM cold_model_snapshot WHERE attempt = 'B'
  ON CONFLICT (object_key) DO UPDATE
    SET unreferenced_at_ms = greatest(cold_model_garbage.unreferenced_at_ms, EXCLUDED.unreferenced_at_ms);
SAVEPOINT creation_only;
DELETE FROM cold_model_object o
  WHERE o.created_at_ms < (SELECT now_ms - window_ms FROM cold_model_clock)
    AND NOT EXISTS (SELECT 1 FROM cold_model_actor a
      WHERE a.actor_id = o.actor_id AND a.cold_ref = o.object_key)
    AND NOT EXISTS (SELECT 1 FROM cold_model_outbox pending
      WHERE pending.actor_id = o.actor_id AND pending.kind = 'cold');
INSERT INTO cold_model_results SELECT 'creation_age_only_breaks_retained_backup',
  EXISTS (SELECT 1 FROM cold_model_backup b
    WHERE b.taken_at_ms > (SELECT now_ms - window_ms FROM cold_model_clock)
      AND NOT EXISTS (SELECT 1 FROM cold_model_object o WHERE o.object_key = b.cold_ref));
SELECT * FROM cold_model_results WHERE scenario = 'creation_age_only_breaks_retained_backup';
ROLLBACK TO SAVEPOINT creation_only;
INSERT INTO cold_model_results SELECT 'latest_unreference_protects_retained_backup',
  NOT EXISTS (SELECT 1 FROM cold_model_deletable)
  AND NOT EXISTS (SELECT 1 FROM cold_model_reconciliable)
  AND EXISTS (SELECT 1 FROM cold_model_backup b JOIN cold_model_object o ON o.object_key = b.cold_ref);

UPDATE cold_model_clock SET now_ms = 6000;
INSERT INTO cold_model_outbox VALUES ('vault-a', 'cold', 900000, 9);
INSERT INTO cold_model_results SELECT 'retrying_cold_row_protects_aged_object',
  NOT EXISTS (SELECT 1 FROM cold_model_deletable)
  AND NOT EXISTS (SELECT 1 FROM cold_model_reconciliable)
  AND (SELECT count(*) = 1 FROM cold_model_object);

INSERT INTO cold_model_object VALUES ('recent-orphan', 'vault-a', convert_to('recent', 'UTF8'), 5900);
INSERT INTO cold_model_garbage VALUES ('vault-a', 'recent-orphan', 5900);
DELETE FROM cold_model_outbox WHERE actor_id = 'vault-a';
WITH deleted AS (
  DELETE FROM cold_model_object o USING cold_model_deletable g
    WHERE o.object_key = g.object_key RETURNING o.object_key
)
INSERT INTO cold_model_results SELECT 'deletes_only_old_unreferenced_object', count(*) = 1 FROM deleted;
INSERT INTO cold_model_results SELECT 'recent_candidate_retained_and_warm_state_intact',
  (SELECT count(*) = 1 FROM cold_model_object WHERE object_key = 'recent-orphan')
  AND (SELECT value = convert_to('{"version":1,"state":{"balance":73},"blob":[11,29,47]}', 'UTF8')
    FROM cold_model_state WHERE actor_id = 'vault-a')
  AND (SELECT generation = 42 AND cold_ref IS NULL FROM cold_model_actor WHERE actor_id = 'vault-a');

INSERT INTO cold_model_object VALUES ('upload-orphan', 'vault-a', convert_to('never-flipped', 'UTF8'), 100);
WITH deleted AS (
  DELETE FROM cold_model_object o USING cold_model_reconciliable candidate
    WHERE o.object_key = candidate.object_key RETURNING o.object_key
)
INSERT INTO cold_model_results SELECT 'reconciliation_collects_only_unrecorded_old_upload',
  count(*) = 1 AND bool_and(object_key = 'upload-orphan') FROM deleted;

SELECT * FROM cold_model_results ORDER BY scenario;
ROLLBACK;
```

## Recorded result

Run on 2026-10-09 with Postgres 18.6 (Debian `18.6-1.pgdg12+2`). The SQL was extracted verbatim from this document and executed as a focused `docker exec ... psql -X -v ON_ERROR_STOP=1` probe; no local framework suite ran. It exited 0 in 3.4 seconds including container-exec overhead.

Both unsafe savepoint probes produced their counterexamples (`true`): age-only deletion broke the current cold reference, and creation-age-only reconciliation broke the retained backup reference. Each probe was rolled back. All ten final guarded/transition observations were `true`: same-key verification, the winning flip, guarded abort recording, live-reference protection, restored-reference protection, latest-unreference backup protection, in-flight protection, eligible old-object collection, recent-object/byte preservation, and never-flipped orphan reconciliation. The final rollback left no persistent database objects.

The admission seam was independently checked in the current source: [dispatch](../../packages/akter/src/runtime/layer.ts) has no pre-delivery receipt read, [fenced admission](../../packages/akter/src/runtime/turn/execute.ts) joins receipts after locking the generation row, and [ADR 0072](../decisions/0072-served-command-in-two-round-trips.md) deliberately removed `readAdmission`. This is a source trace, not executed cold-fetch or latency evidence.
