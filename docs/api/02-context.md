# Context capabilities

**Responsibility:** define `Context` phases and capabilities.  
**Authority:** API contract.  
**Owner role:** API/runtime.

`yield* Context` is the one application-facing service acquisition. `ctx.database`, `ctx.blobs`, `ctx.emit`, `ctx.timers`, `ctx.activities`, `ctx.workflows`, and `ctx.realtime` are capabilities whose authority depends on the phase.

Command context may write owned rows and durable intents. Query context may read authorized data. Activity and job contexts may perform their declared external work but cannot retain the command writer. Type-level restrictions improve ergonomics; runtime checks remain authoritative.
