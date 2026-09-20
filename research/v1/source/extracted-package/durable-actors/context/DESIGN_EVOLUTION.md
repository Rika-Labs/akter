# Decisions corrected during research

The conversation contains useful product ideas and several overconfident implementation shortcuts. This dossier resolves them explicitly:

- Actors are first scope; agents and broad specializations are deferred.
- Private actor DBs are the chosen product direction, but one DB per every trivial row is not mandatory domain guidance.
- Turso means a verified libSQL-compatible endpoint, not every feature of the newer engine automatically working with @effect/sql-libsql.
- PostgreSQL mailbox ACK and actor SQLite mutations are not one atomic transaction. Local receipts/outboxes and a recoverable bridge are required.
- Timer/activity intentions originate in the actor-local transaction even when actual runtime scheduling/delivery lives in PostgreSQL.
- Cluster lease ownership alone does not fence remote DB writes.
- Live broadcast is distinct from durable/replayable history.
- Customer-owned projection DBs avoid mixing unrelated customer application schemas in our control DB.
- Projection actors can consume the source stream directly; PostgreSQL is not necessarily an intermediate.
- Automatic projection declarations are attractive API proposals, not existing Effect features.
- Effect SQL is core; a Drizzle-like custom ORM is not required.
- Layer.mergeAll does not wire sibling dependencies or automatically override constructed defaults.
- Bun is primary, but Node compatibility is a tested adapter contract, not a slogan.
- Everything is not independently interchangeable: backend implementations must preserve the same correctness contract.
- Cost, throughput, cloud maturity and enterprise contracts need evidence. Earlier illustrative numbers are not validated forecasts.
