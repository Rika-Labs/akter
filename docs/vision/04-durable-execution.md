# Durable execution

An action is synchronous and deterministic. It can mutate state, edit a list, stage a send or timer, start a job, or emit an event, but cannot perform I/O. Recorded `id()`, `now()`, and `random()` inputs make the same action reproducible during recovery.

Jobs run I/O as Effects after durable start. A completed named step is journaled and never repeated. A crash during I/O can leave an ambiguous provider effect, so applications use provider idempotency keys and reconciliation. Retries of job-to-action calls preserve crash identity; intentional retry attempts get fresh ids unless a completed step already contains the call.

Timers and per-instance cron ticks are durable obligations. Stopped stores need a host wake path based on `nextDue`. There is no promise that a stopped process wakes itself or that a job is globally exactly once.
