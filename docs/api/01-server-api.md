# Server API

**Responsibility:** define actor declarations and server composition.  
**Authority:** API design.  
**Owner role:** API/Effect.

The server API is Effect-native and declarative. Actor definitions contain commands, events, subscriptions, connections, and durable work declarations. Server-only handlers and credentials never enter generated client contracts.

The public API must make illegal phase usage difficult, provide runtime decoding for plain JavaScript input, and preserve stable operation identity across retries.
