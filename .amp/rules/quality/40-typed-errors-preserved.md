---
enabled: true
paths:
  - packages/**
  - apps/**
  - examples/**
  - tooling/**
exclude: []
on: code-change
severity: error
threshold: 0.9
priority: 15
contextFiles:
  - docs/contracts/error-model.md
---

# Typed errors keep their type and cause

Errors must keep their declared type and their cause. Swallowing a typed
error into a bare `Error`, dropping the `cause`, catching broadly and
returning a generic failure, converting a failure into a silent success, or
rethrowing without the original error are violations.

Declared command errors are never wrapped in `ActorError` or any other
framework error — `ActorError` is reserved for the reasons the runtime
itself produces (`ActorUnavailable`, `MailboxFull`, `Timeout`,
`CommandConflict`, `CommandExpired`, `InvalidCommandId`, `NotCreated`,
`Unauthorized`, `InvalidInput`, `TransportError`).

Clean: `Effect.catchTag('HttpError', (cause) => new SessionExpired({ cause
}))`; letting the declared error propagate; a deliberate fallback at the
outermost HTTP boundary that renders a user-facing error response; and, at
the process startup boundary, a sanitized diagnostic whose raw cause may
contain credentials — startup must still fail, and this exception never
permits dropping declared command errors or turning failure into success.

Flag only a visible erasure of type or cause. A caught error that is
rethrown unchanged, mapped with its cause preserved, or converted at a
documented boundary is clean; abstain when the changed lines do not show the
handling path.
