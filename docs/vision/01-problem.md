# 01 — The problem

## Vision

Durable Actors exists for applications whose important things have identity, memory, behavior, and ongoing work.

Examples include:

- a customer account;
- a team or project;
- a chat room;
- a document or collaborative session;
- an IoT device;
- an agent;
- a workflow;
- a subscription or order.

Today, these are usually implemented with tables, API handlers, queues, workers, cron, WebSockets, caches, retry tables, and ad hoc locking. Each feature invents its own coordination rules.

Durable Actors gives each important thing a durable runtime so its behavior can be expressed together.

## The customer promise

> Build stateful applications without building distributed systems by hand.

The framework should make it straightforward to create a thing that can:

- receive commands;
- own mutations;
- read relational data;
- communicate with other things;
- publish realtime updates;
- schedule future work;
- call external services;
- survive process failure;
- reconnect clients;
- remain inspectable with ordinary database tools.

## We are not building

- another private key-value store;
- a hosted-only edge platform;
- a replacement for SQL;
- a generic function-as-a-service product;
- a hostile-code sandbox;
- a promise that every distributed operation is globally atomic or exactly once.
