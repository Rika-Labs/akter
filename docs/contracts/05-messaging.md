# Messaging and events

**Responsibility:** define actor communication and durable publication.  
**Authority:** normative.  
**Owner role:** runtime/realtime.  
**Change policy:** wire changes require protocol versioning and replay tests.

Messages sent from a turn are durable intents committed with that turn. Delivery is at-least-once and receivers deduplicate using stable message identity.

Events describe committed facts or committed transitions. They are never emitted for a transaction that later rolls back. Retention, ordering scope, replay boundaries, and authorization are explicit per event stream.

Messaging does not create a global transaction. A command sent to another actor is a durable message, not a remote function call hidden inside the sender's transaction.
