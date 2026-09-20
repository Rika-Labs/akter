# Transaction catalog

**Responsibility:** show which facts share a commit boundary.  
**Authority:** design.  
**Owner role:** storage/runtime.

| Operation | In the turn transaction                | Outside the transaction |
| --------- | -------------------------------------- | ----------------------- |
| Command   | business rows, receipt, event, intents | response delivery       |
| Message   | destination receipt and transition     | network delivery        |
| Activity  | execution intent                       | provider call           |
| Workflow  | journal transition                     | step activity           |
| Blob      | verified reference/attestation         | object bytes            |
| Realtime  | snapshot/cursor boundary               | socket delivery         |
| Transfer  | phase transition                       | cross-authority copying |

No transaction remains open while waiting for a socket, another actor, a timer, object storage, or an external provider.
