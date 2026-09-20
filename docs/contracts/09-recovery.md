# Failure and recovery

**Responsibility:** define behavior across crashes and restarts.  
**Authority:** normative.  
**Owner role:** reliability.  
**Change policy:** every new durable record needs a crash-point analysis.

The runtime must be correct when a process dies:

- before transaction begin;
- during handler execution;
- after provider intent but before commit;
- after commit but before response;
- after enqueue but before delivery;
- during activity execution;
- during ownership transfer;
- during restore.

Recovery reconstructs authority from durable state, fences stale generations, resumes eligible work, preserves unknown outcomes, and exposes repair state. Process-local memory is an optimization, never the source of truth.
