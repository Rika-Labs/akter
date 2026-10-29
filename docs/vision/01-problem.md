# The problem

Stateful backends combine durable data, retry-safe requests, background work, timers, and realtime sessions. Implementing each separately makes it easy to reply before data is safe, repeat a payment after a lost reply, or lose a job when a process restarts.

Akter gives an addressable actor ownership of its state and obligations. A short deterministic command produces one recorded outcome and staged work. Durability is the publication boundary; slow or external work is a job.

The product is not a database, SQL layer, arbitrary distributed transaction system, or hostile-code sandbox. It does not make external effects exactly once without provider cooperation.
