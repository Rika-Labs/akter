# Generated contracts

Akter 0.2 does not generate Promise, React, Python, OpenAPI, or MCP clients. Actor contracts are TypeScript values shared by the root package, server, testing layer, and Effect client.

The contract exposes schemas for state, action payloads and replies, list items, views, events, jobs, and declared failures. The server and client derive their wire codecs from the same contract, while stored bytes use the store's `SchemaBinary` format.
