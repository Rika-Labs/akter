# API naming

**Responsibility:** keep public terminology deliberate.  
**Authority:** API design.  
**Owner role:** API/SDK.

Accepted direction:

- `Actor.define`
- `Context`
- `ctx.database`
- `ctx.blobs`
- `ctx.emit`
- `ctx.timers`
- `ctx.activities`
- `ctx.jobs`
- `ctx.workflows`
- `ctx.realtime`

Avoid `state.db`, `database.db`, repeated `database.execute(...)`, separate `yield* State`/`yield* Database` ceremony, and `Realtime.forActor(...)` registration.

Names are not final until the API ADR and generated-client fixtures agree.
