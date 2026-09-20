# Dispatch and fencing

**Responsibility:** describe how work reaches one current actor generation.  
**Authority:** design.  
**Owner role:** runtime/reliability.

Dispatch is a hint; durable inbox and receipt state are the authority. A runner claims work, obtains a generation/fence, executes a bounded turn, and commits only while its fence remains valid.

Recovery may assign work to a new runner. The old runner can continue running locally but its commit must fail safely. Polling remains available when notifications are lost.

The design must avoid requiring one global queue, one global lock, or one always-resident process.
