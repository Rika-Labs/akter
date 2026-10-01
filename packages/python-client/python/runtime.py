"""The runtime a generated Durable Actors client calls into.

OpenAPI describes the routes and their schemas; it cannot say how a client
keeps command identity. This module holds that policy, and nothing else is
copied between generated packages. It uses only the standard library.

A command needs an id minted once, before its first attempt, and sent unchanged
with the same body on every retry: the server replays the stored result for
the same id and body, and refuses the same id with another body. A client that
minted a new id after a lost reply could run the command twice, so this runtime
never does, including when an id expires.
"""

from __future__ import annotations

import email.utils
import http.client
import json
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable, Dict, NamedTuple, Optional, Union

__all__ = [
    "ActorError",
    "ActorUnavailable",
    "CommandConflict",
    "CommandExpired",
    "DeclaredError",
    "Defect",
    "InvalidCommandId",
    "InvalidInput",
    "MailboxFull",
    "NotCreated",
    "RunnerAtCapacity",
    "Runtime",
    "SessionEnded",
    "Timeout",
    "TransportError",
    "Unauthorized",
    "UnexpectedResponse",
]

PROTOCOL_VERSION = "1"

CLOCK_SLACK_MS = 1000
"""Ids are minted this far behind the corrected clock, since the server refuses an id issued in its future."""

MIN_REMAINING_MS = 1000
"""A command is not retried once its id expires within this long."""

FIRST_NETWORK_DELAY_S = 0.1

MAX_NETWORK_DELAY_S = 2.0

TIMEOUT_DELAY_S = 0.05
"""A `Timeout` is retried after this, jittered by half either way: the turn may still be running."""

FUTURE_SLACK_S = 0.05

NOMINAL_RETRY_AFTER_MS = {"ActorUnavailable": 250, "RunnerAtCapacity": 1000, "MailboxFull": 100}
"""The waits an envelope without `retryAfter` implies, jittered by half either way."""

RETRYABLE_STATUSES = (408, 429)
"""With any 5xx, statuses a proxy or gateway may answer before a runner saw the request."""

COMMAND_ID = re.compile(r"^v1\.(\d+)\.(\d+)\.[0-9a-f-]{36}$")

UNSET: Any = object()

Token = Union[str, Callable[[], str], None]


class Response(NamedTuple):
    status: int
    headers: Dict[str, str]
    body: bytes


class NetworkFailure(Exception):
    """No response arrived: the request may or may not have reached the server."""


class TransportError(Exception):
    """Every attempt ended without a response."""


class UnexpectedResponse(Exception):
    """A response that is not one of the served protocol's bodies.

    `retryable` is true for a status a proxy or gateway may answer before any
    runner saw the request, which the command is retried after with its id.
    """

    def __init__(self, status: int, text: str, retry_after_ms: Optional[float] = None) -> None:
        super().__init__("unexpected response %d: %s" % (status, text[:200]))
        self.status = status
        self.text = text
        self.retryable = status >= 500 or status in RETRYABLE_STATUSES
        self.retry_after_ms = retry_after_ms


class Defect(Exception):
    """The server hit a defect; `trace_id` names it in the server's logs."""

    def __init__(self, status: int, body: Dict[str, Any]) -> None:
        super().__init__("defect, trace %s" % body.get("traceId"))
        self.status = status
        self.body = body
        self.trace_id: Optional[str] = body.get("traceId")


class DeclaredError(Exception):
    """A failure the member declares; `tag` and `body` are its encoded error."""

    def __init__(self, status: int, body: Dict[str, Any]) -> None:
        super().__init__("%s (status %d)" % (body.get("_tag"), status))
        self.status = status
        self.body = body
        self.tag: str = body["_tag"]


class ActorError(Exception):
    """A framework failure: `tag` is the reason (`CommandExpired`, `Unauthorized`, ...)."""

    def __init__(self, status: int, body: Dict[str, Any], header_retry_after_ms: Optional[float]) -> None:
        reason: Dict[str, Any] = body.get("reason") or {}
        super().__init__("%s (status %d)" % (reason.get("_tag"), status))
        self.status = status
        self.body = body
        self.reason = reason
        self.tag: str = reason.get("_tag", "")
        self.code: Optional[str] = reason.get("code")
        self.is_retryable: bool = bool(body.get("isRetryable"))
        retry_after = body.get("retryAfter")
        self.retry_after_ms: Optional[float] = (
            retry_after if retry_after is not None else header_retry_after_ms
        )
        self.command_id: Optional[str] = reason.get("commandId")


class CommandConflict(ActorError):
    """The command id was already used with different input."""


class CommandExpired(ActorError):
    """The command id is older than the retry window. Surface it; never mint a replacement."""


class InvalidCommandId(ActorError):
    pass


class Unauthorized(ActorError):
    pass


class ActorUnavailable(ActorError):
    pass


class RunnerAtCapacity(ActorError):
    pass


class MailboxFull(ActorError):
    pass


class Timeout(ActorError):
    pass


class NotCreated(ActorError):
    pass


class InvalidInput(ActorError):
    pass


class SessionEnded(ActorError):
    pass


class TransportFailure(ActorError):
    pass


REASONS: Dict[str, type] = {
    cls.__name__: cls
    for cls in (
        CommandConflict,
        CommandExpired,
        InvalidCommandId,
        Unauthorized,
        ActorUnavailable,
        RunnerAtCapacity,
        MailboxFull,
        Timeout,
        NotCreated,
        InvalidInput,
        SessionEnded,
    )
}

REASONS["TransportError"] = TransportFailure


def path(template: str, actor_id: Optional[str] = None) -> str:
    """A route's path, with the actor id as one percent-encoded segment."""
    if actor_id is None:
        return template
    return template.replace("{id}", urllib.parse.quote(actor_id, safe=""))


def urllib_transport(
    method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float
) -> Response:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as reply:
            return Response(reply.status, _lower(reply.headers.items()), reply.read())
    except urllib.error.HTTPError as reply:
        return Response(reply.code, _lower(reply.headers.items()), reply.read())
    except (urllib.error.URLError, http.client.HTTPException, OSError) as failure:
        raise NetworkFailure(str(failure)) from failure


def _lower(items: Any) -> Dict[str, str]:
    return {name.lower(): value for name, value in items}


def retry_after_header(headers: Dict[str, str], now_ms: float) -> Optional[float]:
    """A `retry-after` header in milliseconds: delay seconds, or an HTTP date
    measured from the response's `date`, else from `now_ms`."""
    value = (headers.get("retry-after") or "").strip()
    if value == "":
        return None
    if value.isdigit():
        return int(value) * 1000.0
    try:
        at = email.utils.parsedate_to_datetime(value).timestamp() * 1000.0
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    sent = now_ms
    date = headers.get("date")
    if date is not None:
        try:
            sent = email.utils.parsedate_to_datetime(date).timestamp() * 1000.0
        except (TypeError, ValueError, IndexError, OverflowError):
            pass
    return max(0.0, at - sent)


class Runtime:
    """Sends requests for a generated client, keeping one id per command.

    `token` is a bearer credential, or a function called before every attempt,
    so a command whose credential expired is retried once with a fresh one and
    the same command id.
    """

    def __init__(
        self,
        base_url: str,
        *,
        protocol_path: str,
        token: Token = None,
        headers: Optional[Dict[str, str]] = None,
        timeout: float = 30.0,
        max_attempts: int = 8,
        transport: Callable[..., Response] = urllib_transport,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.time,
        jitter: Callable[[], float] = random.random,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._protocol_path = protocol_path
        self._token = token
        self._headers = dict(headers or {})
        self._timeout = timeout
        self._max_attempts = max_attempts
        self._transport = transport
        self._sleep = sleep
        self._now = now
        self._jitter = jitter
        self._offset_ms: Optional[float] = None
        self._best_round_trip_ms: Optional[float] = None
        self._window_ms: Optional[int] = None

    def mint_command_id(self) -> str:
        """A command id valid for the server's retry window, minted from its clock."""
        window = self._protocol()
        issued = int(self._server_now_ms()) - CLOCK_SLACK_MS
        return "v1.%d.%d.%s" % (issued, issued + window, uuid.uuid4())

    def call(
        self,
        route: str,
        *,
        command: bool,
        body: Any = UNSET,
        command_id: Optional[str] = None,
    ) -> Any:
        """One member call. A command keeps `command_id` (minted here when absent) across every retry."""
        payload = None if body is UNSET else json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers = {"accept": "application/json", "durable-protocol": PROTOCOL_VERSION}
        headers.update(self._headers)
        if payload is not None:
            headers["content-type"] = "application/json"

        expires_at: Optional[int] = None
        issued_at: Optional[int] = None
        if command:
            key = command_id if command_id is not None else self.mint_command_id()
            headers["idempotency-key"] = key
            parsed = COMMAND_ID.match(key)
            if parsed is not None:
                issued_at, expires_at = int(parsed.group(1)), int(parsed.group(2))

        refreshed = False
        future_retried = False
        attempt = 0
        while True:
            attempt += 1
            headers = self._authorized(headers)
            try:
                response = self._send("POST", route, headers, payload)
                return self._decode(response)
            except NetworkFailure as failure:
                delay = self._backoff(attempt)
                if not self._may_retry(attempt, expires_at, delay):
                    raise TransportError(str(failure)) from failure
            except UnexpectedResponse as unexpected:
                if not unexpected.retryable:
                    raise
                delay = (
                    unexpected.retry_after_ms / 1000.0
                    if unexpected.retry_after_ms is not None
                    else self._backoff(attempt)
                )
                if not self._may_retry(attempt, expires_at, delay):
                    raise
            except ActorError as error:
                delay_or_none = self._delay(error, issued_at, future_retried)
                if error.tag == "InvalidCommandId":
                    future_retried = True
                if error.tag == "Unauthorized" and error.code == "expired":
                    if refreshed or not callable(self._token):
                        raise
                    refreshed = True
                    delay_or_none = 0.0
                if delay_or_none is None or not self._may_retry(attempt, expires_at, delay_or_none):
                    raise
                delay = delay_or_none
            self._sleep(delay)

    def _backoff(self, attempt: int) -> float:
        delay = min(MAX_NETWORK_DELAY_S, FIRST_NETWORK_DELAY_S * 2 ** (attempt - 1))
        return delay * (0.5 + self._jitter())

    def _delay(
        self, error: ActorError, issued_at: Optional[int], future_retried: bool
    ) -> Optional[float]:
        """Seconds to wait before retrying with the same id, or None when the failure is final.

        A server's `retryAfter` is already jittered, so it is waited out as sent.
        An id the server found in its future is resent once, after its issue time.
        """
        nominal = NOMINAL_RETRY_AFTER_MS.get(error.tag)
        if nominal is not None:
            if error.retry_after_ms is None:
                return nominal / 1000.0 * (0.5 + self._jitter())
            return error.retry_after_ms / 1000.0
        if error.tag == "Timeout":
            return TIMEOUT_DELAY_S * (0.5 + self._jitter())
        if (
            error.tag == "InvalidCommandId"
            and error.code == "future"
            and issued_at is not None
            and not future_retried
        ):
            return max(FUTURE_SLACK_S, (issued_at - self._server_now_ms()) / 1000.0 + FUTURE_SLACK_S)
        return None

    def _may_retry(self, attempt: int, expires_at: Optional[int], delay: float) -> bool:
        if attempt >= self._max_attempts:
            return False
        if expires_at is None:
            return True
        return expires_at - (self._server_now_ms() + delay * 1000.0) > MIN_REMAINING_MS

    def _protocol(self) -> int:
        if self._window_ms is None:
            reply = self._decode(self._send("GET", self._protocol_path, {}, None))
            self._window_ms = int(reply["retryWindowMs"])
            if self._offset_ms is None:
                self._sample_clock(float(reply["now"]), 0.0, self._now() * 1000.0)
        return self._window_ms

    def _server_now_ms(self) -> float:
        offset = self._offset_ms if self._offset_ms is not None else 0.0
        return self._now() * 1000.0 + offset

    def _sample_clock(self, server_ms: float, round_trip_ms: float, received_ms: float) -> None:
        """Keeps the offset of the fastest response, whose midpoint error is smallest."""
        if self._best_round_trip_ms is not None and round_trip_ms > self._best_round_trip_ms:
            return
        self._best_round_trip_ms = round_trip_ms
        self._offset_ms = server_ms - (received_ms - round_trip_ms / 2.0)

    def _authorized(self, headers: Dict[str, str]) -> Dict[str, str]:
        token = self._token() if callable(self._token) else self._token
        result = {name: value for name, value in headers.items() if name != "authorization"}
        if token is not None:
            result["authorization"] = "Bearer %s" % token
        return result

    def _send(
        self, method: str, route: str, headers: Dict[str, str], body: Optional[bytes]
    ) -> Response:
        started = self._now() * 1000.0
        response = self._transport(
            method, self._base_url + route, headers, body, self._timeout
        )
        finished = self._now() * 1000.0
        server_now = response.headers.get("durable-now")
        if server_now is not None and server_now.isdigit() and response.status != 504:
            self._sample_clock(float(server_now), finished - started, finished)
        return response

    def _decode(self, response: Response) -> Any:
        if response.status == 204:
            return None
        text = response.body.decode("utf-8", errors="replace")
        header_retry_after = retry_after_header(response.headers, self._now() * 1000.0)
        try:
            body = json.loads(text) if text else None
        except ValueError:
            raise UnexpectedResponse(response.status, text, header_retry_after) from None
        if 200 <= response.status < 300:
            return body
        if isinstance(body, dict) and body.get("_tag") == "ActorError":
            reason = (body.get("reason") or {}).get("_tag", "")
            raise REASONS.get(reason, ActorError)(response.status, body, header_retry_after)
        if isinstance(body, dict) and body.get("_tag") == "Defect":
            raise Defect(response.status, body)
        if isinstance(body, dict) and isinstance(body.get("_tag"), str):
            raise DeclaredError(response.status, body)
        raise UnexpectedResponse(response.status, text, header_retry_after)
