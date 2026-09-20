# Drizzle integration

**Responsibility:** define the relational query experience.  
**Authority:** API design.  
**Owner role:** database/API.

Use Drizzle semantics rather than inventing a proprietary query language. Re-export only stable, useful Drizzle surface through documented subpaths. Do not re-export database drivers, pools, dialect internals, migration CLIs, or unrelated runtime globals merely for convenience.

The adapter must define how builders become Effect-yieldable, how they bind to the current transaction, which mutations receive ownership enforcement, and which query forms are unsupported. TypeScript types are not a substitute for runtime authority.
