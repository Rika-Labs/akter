# Receipts, retries, and identity

**Responsibility:** define duplicate and ambiguous command behavior.  
**Authority:** normative.  
**Owner role:** runtime/reliability.  
**Change policy:** retention changes require restore and external-effect review.

A receipt records the logical command identity, actor identity, request hash, authorization context, status, result or error, attempt history, and retention boundary.

The same command ID with the same request returns or observes the existing logical result. Reusing it with a different request is a permanent conflict. A lost response after commit is recovered through the receipt, not by blindly executing the handler again.

Receipt retention bounds deduplication. The runtime must expose expiry rather than implying an identity remains safe forever.

`unknown` is a first-class status for an external operation whose provider outcome cannot yet be determined. It is not equivalent to failure.
