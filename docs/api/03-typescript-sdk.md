# TypeScript SDK

**Responsibility:** define the non-Effect client experience.  
**Authority:** API design.  
**Owner role:** SDK.

The SDK is derived from the same schemas and protocol as the Effect server. It uses Promises, async iterators, AbortSignals, typed command inputs, typed results, and typed subscription frames.

It must not create a second actor runtime or imply that client cancellation undoes accepted durable work. Reconnect, receipt lookup, resync, and protocol errors are first-class SDK behavior.
