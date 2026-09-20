# Generated contracts

**Responsibility:** define what actor definitions expose to clients.  
**Authority:** API design.  
**Owner role:** SDK/protocol.

Generate typed command inputs/results, errors, actor addresses, events, subscription frames, cursors, and transport methods. Never generate handlers, credentials, database factories, privileged queries, provider clients, or server-only context capabilities.

The generated Promise SDK and Effect client consume the same runtime schemas and protocol. Generated code must be inspectable, versioned, and safe to include in a browser bundle.
