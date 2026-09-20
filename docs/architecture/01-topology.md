# System topology

**Responsibility:** map logical runtime responsibilities.  
**Authority:** design.  
**Owner role:** runtime architecture.

```text
client → gateway → admission → actor dispatcher → turn transaction
   ↑                                      ↓
   └──── subscriptions / replay ← committed events

database ← turns / receipts / work intents / business rows
workers  ← post-commit intents
blobs    ← actor-scoped object adapter
```

Gateway, dispatcher, worker, and query services may be colocated in small deployments. They are logical boundaries, not mandatory microservices.

The database is the durable authority. Process memory holds activations, caches, and connections only as rebuildable or explicitly ephemeral state.
