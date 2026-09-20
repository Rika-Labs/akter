# Storage and ownership

**Responsibility:** define relational storage behavior.  
**Authority:** normative.  
**Owner role:** database/runtime.  
**Change policy:** Drizzle, Postgres, and each backend adapter must agree on the supported query matrix.

Business tables remain ordinary relational tables. Ownership metadata is derived from trusted actor context and is not an ordinary caller-controlled input.

Reads are authorized separately from writes. Actor handlers receive actor-scoped mutation capabilities; dashboards, queries, and background phases receive only the authority they need.

The framework must define behavior for single-row updates, broad predicates, joins, upserts, cascades, deletes, raw SQL, and mixed-owner targets. “The database filtered it out” is not an ownership error contract.

Drizzle syntax is the developer-facing query model. Re-exporting a symbol does not by itself make a builder transaction-bound, yieldable, or ownership-safe.
