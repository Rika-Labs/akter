# The product model

An actor is a typed address, schema state, actions, and optional lists, views, events, jobs, and presence. `Actor.make` declares it once for the server and Effect client. `X.toLayer` binds its synchronous actions and Effect jobs.

## The action model

Actions run one at a time per actor against copy-on-write drafts. They may stage sends, timers, job starts, and events; all are discarded on declared failure, defect, page miss, or lost segment. A reply and every published consequence wait until the shard's segment is durable.

State decodes from `{}` using field defaults. `Actor.list` moves unbounded item data into pages. Views derive shapes from durable state; `X.find` discovers actor ids from top-level scalar fields, not arbitrary SQL.

## Authority

One environment has one store bucket. The shard's immutable segment chain and open epoch authorize writes. Membership locks and memory are advisory. The system must refuse missing or corrupt authority rather than invent state.

The model's unlimited-list, GC, fork, and hosted provider guarantees depend on their own milestone evidence, not on declarations or design diagrams.
