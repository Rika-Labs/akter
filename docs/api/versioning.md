# API and protocol versioning

**Responsibility:** preserve compatibility across rolling deployments.  
**Authority:** normative API design.  
**Owner role:** API/reliability.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

The four package entries version together. Published packages start at `0.1.0-alpha.0` on the `alpha` dist-tag; an alpha may change APIs and stored formats without a migration path, and the first alpha supports one runner per database ([ADR 0029](../decisions/0029-licence-package-name-and-release-policy.md)). The compatibility rules below bind from the first non-alpha release. Persisted commands, receipts, events, keyed state, connection state, workflow records, transport frames, OpenAPI, and Promise-client contracts remain decodable during rolling deployment.

Evolution is additive by default: add schema fields with decoding defaults before requiring them, retain stable actor and member tags, and do not reuse a command identity for different semantics. Keyed state changes use a validated `Actor.migration` chain; table changes use SQL migrations.

Receipts must replay both successful results and declared failures under newer code, subject to current receipt-access and external retry-horizon rules. Retained events and pending effects decode through their declared migration chains for their full retention window, and a deploy that would strand one is refused at startup (target, M4.7, [ADR 0032](../decisions/0032-event-and-effect-payload-evolution.md)). Command inputs and outputs stay additive. A TypeScript-only change without runtime-schema, stored-payload, OpenAPI, and rolling-deployment review is not compatible.

Command expiry is enforced from the database clock and holds across restore ([ADR 0004](../decisions/0004-receipt-access-revocation-and-expiry.md), [backup and restore](../operations/04-backup-restore.md)). Logical caller identity and receipt-access error mappings still require an explicit compatibility design before implementation. Do not silently reinterpret an existing id as fresh or add undocumented `ActorError` reasons/codes.
