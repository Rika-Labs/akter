# Customer stories

These are intended workloads, not production-provider endorsements.

- A room owns title and membership state, a page-backed message list, presence, and live views. Persist messages in the list; typing broadcasts are ephemeral.
- An order owns its status and line-item list. A synchronous command starts a payment job; named steps and provider idempotency keys handle ambiguous network effects.
- An agent session owns durable conversation state and job progress. Save final output through a command rather than treating token broadcasts as history.
- A device actor owns current readings and scheduled work. The host restarts a stopped store when `nextDue` requires it.

A multi-tenant workspace needs proven address and credential isolation. The current framework server is limited to the `default` tenant; the hosted boundary must not be inferred from these stories.
