# Actor lifecycle

**Responsibility:** describe identity, activation, turns, and passivation.  
**Authority:** design.  
**Owner role:** runtime.

```text
identity → activation → command turn → passivation → activation
                         ↓
                     durable facts
```

Identity survives process death. Activation is disposable. A turn is short and transaction-bound. Passivation releases process-local resources but does not delete identity, receipts, events, or scheduled work.

An activation may hold read models and supervised resources only when they can be rebuilt or interrupted safely. It must never be the sole owner of a business fact.
