# Runtime storage layout

**Responsibility:** organize framework-private durable records.  
**Authority:** design.  
**Owner role:** database/runtime.

Framework tables should be distinguishable from application tables and protected from ordinary application mutation. Candidate records include actor generations, receipts, messages, events, timers, work executions, transfer phases, cursors, and blob attestations.

Application tables remain ordinary tables with generated ownership metadata where required. The layout must support migrations, retention, tenant filtering, indexes, restore, and inspection without requiring a private database per actor.

Physical names and columns remain subject to the storage contract and adapter benchmarks.
