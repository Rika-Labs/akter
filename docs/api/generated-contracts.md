---
title: "Generated contracts"
description: "Akter generates no extra clients: actor contracts are TypeScript values shared by every layer."
---

# Generated contracts

Akter 0.2 does not generate Promise, React, Python, OpenAPI, or MCP clients. An actor contract is a TypeScript value, shared by the root package, the server, the testing layer, and the Effect client.

The contract holds the schemas for state, action payloads and replies, list items, views, events, jobs, and declared failures. The server and client derive their wire codecs from that one contract, so they cannot drift apart. Stored bytes use the store's own binary format.

To call an actor from another language, use the `/rpc` protocol directly. It is HTTP NDJSON or WebSocket JSON, and no other client is supported. See the [TypeScript SDK](./03-typescript-sdk.md).
