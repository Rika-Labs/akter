---
enabled: true
paths:
  - packages/durable-actors/**
  - apps/api/**
  - apps/edge/**
exclude: []
on: code-change
severity: error
threshold: 0.9
priority: 10
contextFiles:
  - docs/api/01-server-api.md
---

# No AI-only surface on the framework

The framework ships no AI-specific public surface. Adding `Actor.toolkit`,
`Actor.mcp`, MCP server glue, `llms.txt` generation, agent-specific options
on serve, or framework features that exist only for LLM consumers is a
violation — OpenAPI output is the artifact tool generators consume.

Violations: `Actor.mcp({ tools })`; `serve({ actors, ai: { generateLlmsTxt:
true } })`; a `tool`/`prompt`/`agent` option added to a contract or serve
API that has no meaning outside LLM tool wiring.

Clean: an agent built as an ordinary actor (like `examples/coding-agent`)
that uses contracts, receipts, events, effects, workflows and connections;
`serve({ actors, openapi: true })`; application-level AI code that calls
model providers through ordinary durable effects.

Flag only a visible addition of AI-specific framework surface. User-space
agent features, tool-call loops inside an actor's own code, and OpenAPI
emission are not violations; abstain when the changed lines do not touch a
framework-facing API.
