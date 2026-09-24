# Generated contracts

**Responsibility:** define what actor definitions expose to clients.  
**Authority:** API design.  
**Owner role:** SDK/protocol.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

Actor definitions derive typed handles, the Promise client, and OpenAPI. M6 also plans MCP and generated non-Effect language clients from this same source. Public contracts include identity-mode accessors, command inputs and outputs, declared errors, `ActorError` reasons, queries, streams, events and cursors, connections and frames, and workflow-run handles.

Internal commands, handlers, credentials, database construction, effect executors, server hooks, and privileged context capabilities never enter client contracts. The browser surface imports no SQL or cluster runtime modules.

The Effect handle and Promise client consume the same runtime schemas and stable operation names. Served actors expose OpenAPI for other languages and tool generators. Generated artifacts are inspectable, versioned with the framework distribution, and safe for browser bundles.

MCP is a proposed transport derivation, not an AI runtime. Only public members are exposed; internal commands, executor routes, credentials, and privileged capabilities remain absent. A tool call must carry command identity through retries so a client timeout cannot create a second logical operation.
