# API and protocol versioning

**Responsibility:** preserve compatibility across rolling deployments.  
**Authority:** normative API design.  
**Owner role:** API/reliability.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

The four package entries version together. Persisted commands, receipts, events, keyed state, connection state, workflow records, transport frames, OpenAPI, and Promise-client contracts remain decodable during rolling deployment.

Evolution is additive by default: add schema fields with decoding defaults before requiring them, retain stable actor and member tags, and do not reuse a command identity for different semantics. Keyed state changes use a validated `Actor.migration` chain; table changes use SQL migrations.

Receipts must replay both successful results and declared failures under newer code. Retained events and pending messages must decode for their full retention window. A TypeScript-only change without runtime-schema, stored-payload, OpenAPI, and rolling-deployment review is not compatible.
