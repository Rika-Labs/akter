# Command turns

**Responsibility:** define command admission and execution.  
**Authority:** normative.  
**Owner role:** runtime architecture.  
**Change policy:** update the failure matrix and receipt contract with every lifecycle change.

A command is an authenticated request to one actor. A turn is its bounded execution attempt inside the actor authority and transaction boundary.

```text
admit → authenticate → deduplicate → fence → execute → commit → publish
```

Handlers may perform actor-scoped database work and record durable intents. They must not hold the turn open while waiting for a client, another actor, a timer, a blob provider, or an external API.

The response can mean `committed`, `rejected`, `accepted`, `unknown`, or `expired`. Transport disconnect does not cancel an already accepted command.

Each command has a stable logical identity. Attempts may repeat; the business transition must follow the receipt contract.
