# API and protocol versioning

**Responsibility:** preserve compatibility across rolling deployments.  
**Authority:** normative API design.  
**Owner role:** API/reliability.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

The four package entries version together. Persisted commands, receipts, events, keyed state, connection state, workflow records, transport frames, OpenAPI, and Promise-client contracts remain decodable during rolling deployment.

Evolution is additive by default: add schema fields with decoding defaults before requiring them, retain stable actor and member tags, and do not reuse a command identity for different semantics. Keyed state changes use a validated `Actor.migration` chain; table changes use SQL migrations.

Receipts must replay both successful results and declared failures under newer code, subject to current receipt-access and external retry-horizon rules. Retained events and pending messages must decode for their full retention window. A TypeScript-only change without runtime-schema, stored-payload, OpenAPI, and rolling-deployment review is not compatible.

Logical caller identity, command-expiry encoding/enforcement, and receipt-access/expiry error mappings require an explicit compatibility design before implementation. Old clients or runners must not bypass expiry or caller checks, while accepted internal work remains recoverable. Review credential rotation, policy changes, pruning, clock behavior, and restore alongside schemas; do not silently reinterpret an existing id as fresh or add undocumented `ActorError` reasons/codes. See [ADR 0004](../decisions/0004-receipt-access-revocation-and-expiry.md).
