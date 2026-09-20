# Wire protocol

**Responsibility:** define transport-neutral frames.  
**Authority:** normative API contract.  
**Owner role:** protocol/SDK.

Every request carries protocol version, request ID, actor address where applicable, authentication context, and operation identity. Frames distinguish command, query, subscription, signal, acknowledgement, receipt, event, error, and resync.

Commands return committed, accepted, rejected, unknown, or expired status. A disconnect after acceptance does not cancel work. Subscription streams begin with snapshot and cursor, then events or patches, or an explicit resync-required frame.

HTTP, WebSocket, SSE, in-process clients, Effect clients, and Promise clients adapt this protocol rather than inventing independent semantics.
