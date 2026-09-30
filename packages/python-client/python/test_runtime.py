import json
import re
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Tuple

import runtime

SERVER_NOW_MS = 1_800_000_000_000
WINDOW_MS = 60_000


def envelope(tag: str, retry: bool = False, retry_after: Optional[int] = None, **fields: Any) -> Dict[str, Any]:
    body: Dict[str, Any] = {"_tag": "ActorError", "reason": dict(_tag=tag, **fields), "isRetryable": retry}
    if retry_after is not None:
        body["retryAfter"] = retry_after
    return body


Reply = Tuple[int, Optional[Dict[str, Any]], Dict[str, str]]


class Stub:
    """A real HTTP server that answers each request from a script, and records it."""

    def __init__(self) -> None:
        self.script: List[Any] = []
        self.requests: List[Dict[str, Any]] = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def handle_one(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length) if length else b""
                stub.requests.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "headers": {k.lower(): v for k, v in self.headers.items()},
                        "body": body,
                    }
                )
                if self.path.endswith("/protocol"):
                    self.reply(200, {"protocol": 1, "retryWindowMs": WINDOW_MS, "now": SERVER_NOW_MS}, {})
                    return
                step = stub.script.pop(0)
                if step == "drop":
                    self.close_connection = True
                    self.connection.close()
                    return
                status, payload, headers = step
                self.reply(status, payload, headers)

            def reply(self, status: int, payload: Any, headers: Dict[str, str]) -> None:
                if isinstance(payload, bytes):
                    data = payload
                else:
                    data = b"" if payload is None else json.dumps(payload).encode()
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = handle_one
            do_POST = handle_one

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]

    def calls(self) -> List[Dict[str, Any]]:
        return [r for r in self.requests if not r["path"].endswith("/protocol")]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class Clock:
    def __init__(self) -> None:
        self.seconds = 5_000.0
        self.sleeps: List[float] = []

    def now(self) -> float:
        return self.seconds

    def sleep(self, delay: float) -> None:
        self.sleeps.append(delay)
        self.seconds += delay


class RuntimeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.stub = Stub()
        self.addCleanup(self.stub.close)
        self.clock = Clock()

    def make(self, **options: Any) -> runtime.Runtime:
        defaults: Dict[str, Any] = dict(
            protocol_path="/protocol",
            token="t:alice",
            sleep=self.clock.sleep,
            now=self.clock.now,
            jitter=lambda: 0.5,
        )
        defaults.update(options)
        return runtime.Runtime(self.stub.url, **defaults)

    def command(self, client: runtime.Runtime, **options: Any) -> Any:
        return client.call("/actors/Room/r1/Post", command=True, body={"text": "hi"}, **options)

    def test_mints_a_v1_id_from_the_server_clock_and_window(self) -> None:
        client = self.make()
        key = client.mint_command_id()
        parsed = runtime.COMMAND_ID.match(key)
        self.assertIsNotNone(parsed)
        assert parsed is not None
        issued, expires = int(parsed.group(1)), int(parsed.group(2))
        self.assertEqual(issued, SERVER_NOW_MS - runtime.CLOCK_SLACK_MS)
        self.assertEqual(expires - issued, WINDOW_MS)
        self.assertNotEqual(key, client.mint_command_id())

    def test_sends_one_command_id_and_body_on_every_retry_of_a_retryable_failure(self) -> None:
        unavailable = (503, envelope("ActorUnavailable", True, 2000), {"retry-after": "2"})
        self.stub.script = [unavailable, (429, envelope("MailboxFull", True, 1000), {}), (200, 7, {})]
        self.assertEqual(self.command(self.make()), 7)
        calls = self.stub.calls()
        self.assertEqual(len(calls), 3)
        self.assertEqual(len({c["headers"]["idempotency-key"] for c in calls}), 1)
        self.assertEqual(len({c["body"] for c in calls}), 1)
        self.assertEqual(calls[0]["body"], b'{"text":"hi"}')
        self.assertEqual(calls[0]["headers"]["authorization"], "Bearer t:alice")
        self.assertEqual(self.clock.sleeps, [2.0, 1.0])

    def test_retries_a_timeout_after_about_fifty_milliseconds_with_the_same_id(self) -> None:
        self.stub.script = [(504, envelope("Timeout", True, elapsed=1), {}), (200, 1, {})]
        self.assertEqual(self.command(self.make()), 1)
        calls = self.stub.calls()
        self.assertEqual(calls[0]["headers"]["idempotency-key"], calls[1]["headers"]["idempotency-key"])
        self.assertEqual(self.clock.sleeps, [runtime.TIMEOUT_DELAY_S])

    def test_retries_a_lost_reply_with_the_same_id_and_backs_off_exponentially(self) -> None:
        self.stub.script = ["drop", "drop", (200, 9, {})]
        self.assertEqual(self.command(self.make()), 9)
        calls = self.stub.calls()
        self.assertEqual(len({c["headers"]["idempotency-key"] for c in calls}), 1)
        self.assertEqual(self.clock.sleeps, [0.1, 0.2])

    def test_raises_a_transport_error_after_max_attempts_without_a_response(self) -> None:
        client = self.make(max_attempts=3, protocol_path="/protocol")
        key = client.mint_command_id()
        self.stub.close()
        with self.assertRaises(runtime.TransportError):
            self.command(client, command_id=key)
        self.assertEqual(len(self.clock.sleeps), 2)

    def test_never_retries_or_replaces_an_expired_id(self) -> None:
        self.stub.script = [(410, envelope("CommandExpired", commandId="v1.1.2.x"), {})]
        with self.assertRaises(runtime.CommandExpired) as raised:
            self.command(self.make())
        self.assertEqual(raised.exception.status, 410)
        self.assertEqual(raised.exception.command_id, "v1.1.2.x")
        self.assertEqual(len(self.stub.calls()), 1)
        self.assertEqual(self.clock.sleeps, [])

    def test_raises_a_conflict_without_retrying(self) -> None:
        self.stub.script = [(409, envelope("CommandConflict", commandId="k"), {})]
        with self.assertRaises(runtime.CommandConflict):
            self.command(self.make())
        self.assertEqual(len(self.stub.calls()), 1)

    def test_retries_once_with_a_fresh_credential_and_the_same_id_after_401_expired(self) -> None:
        tokens = iter(["old", "new", "newer"])
        expired = (401, envelope("Unauthorized", code="expired"), {})
        self.stub.script = [expired, (200, 3, {})]
        self.assertEqual(self.command(self.make(token=lambda: next(tokens))), 3)
        calls = self.stub.calls()
        self.assertEqual([c["headers"]["authorization"] for c in calls], ["Bearer old", "Bearer new"])
        self.assertEqual(calls[0]["headers"]["idempotency-key"], calls[1]["headers"]["idempotency-key"])

        self.stub.script = [expired, expired]
        tokens = iter(["a", "b", "c"])
        with self.assertRaises(runtime.Unauthorized):
            self.command(self.make(token=lambda: next(tokens)))

    def test_does_not_retry_401_without_a_refreshable_credential(self) -> None:
        self.stub.script = [(401, envelope("Unauthorized", code="expired"), {})]
        with self.assertRaises(runtime.Unauthorized):
            self.command(self.make())
        self.assertEqual(len(self.stub.calls()), 1)

    def test_does_not_retry_missing_credentials(self) -> None:
        self.stub.script = [(401, envelope("Unauthorized", code="missing_credentials"), {})]
        with self.assertRaises(runtime.Unauthorized) as raised:
            self.command(self.make(token=None))
        self.assertEqual(raised.exception.code, "missing_credentials")
        self.assertNotIn("authorization", self.stub.calls()[0]["headers"])

    def test_retries_an_id_the_server_finds_in_its_future_with_the_same_id(self) -> None:
        future = (400, envelope("InvalidCommandId", commandId="k", code="future"), {})
        self.stub.script = [future, (200, 4, {})]
        self.assertEqual(self.command(self.make()), 4)
        calls = self.stub.calls()
        self.assertEqual(calls[0]["headers"]["idempotency-key"], calls[1]["headers"]["idempotency-key"])

    def test_stops_retrying_when_the_id_is_about_to_expire_and_never_mints_another(self) -> None:
        self.stub.script = [(503, envelope("ActorUnavailable", True, 30_000), {}) for _ in range(20)]
        with self.assertRaises(runtime.ActorUnavailable):
            self.command(self.make(max_attempts=50))
        calls = self.stub.calls()
        self.assertLess(len(calls), 6)
        self.assertEqual(len({c["headers"]["idempotency-key"] for c in calls}), 1)

    def test_uses_a_caller_supplied_id_verbatim_without_asking_for_the_clock(self) -> None:
        self.stub.script = [(200, 1, {})]
        self.command(self.make(), command_id="v1.1.2.custom")
        self.assertEqual(self.stub.requests[0]["headers"]["idempotency-key"], "v1.1.2.custom")
        self.assertEqual(len(self.stub.requests), 1)

    def test_sends_no_command_id_and_reads_no_clock_for_a_query(self) -> None:
        self.stub.script = [(200, {"count": 2}, {})]
        client = self.make()
        self.assertEqual(client.call("/actors/Room/r1/Count", command=False), {"count": 2})
        self.assertEqual(len(self.stub.requests), 1)
        self.assertNotIn("idempotency-key", self.stub.requests[0]["headers"])
        self.assertNotIn("content-type", self.stub.requests[0]["headers"])

    def test_answers_null_and_no_content(self) -> None:
        self.stub.script = [(200, None, {}), (204, None, {})]
        client = self.make()
        self.assertIsNone(client.call("/actors/Room/r1/Peek", command=False))
        self.assertIsNone(self.command(client))

    def test_decodes_declared_errors_defects_and_unknown_bodies(self) -> None:
        self.stub.script = [
            (422, {"_tag": "Full", "capacity": 3}, {}),
            (500, {"_tag": "Defect", "traceId": "abc"}, {}),
            (400, b"<html>bad request</html>", {}),
        ]
        client = self.make()
        with self.assertRaises(runtime.DeclaredError) as declared:
            self.command(client)
        self.assertEqual((declared.exception.tag, declared.exception.body["capacity"]), ("Full", 3))
        with self.assertRaises(runtime.Defect) as defect:
            self.command(client)
        self.assertEqual(defect.exception.trace_id, "abc")
        with self.assertRaises(runtime.UnexpectedResponse) as unexpected:
            self.command(client)
        self.assertFalse(unexpected.exception.retryable)
        self.assertEqual(len(self.stub.calls()), 3)

    def test_gives_up_on_a_gateway_status_after_max_attempts_with_one_id(self) -> None:
        self.stub.script = [(502, b"Bad Gateway", {}) for _ in range(3)]
        with self.assertRaises(runtime.UnexpectedResponse) as unexpected:
            self.command(self.make(max_attempts=3))
        self.assertEqual(unexpected.exception.status, 502)
        calls = self.stub.calls()
        self.assertEqual(len(calls), 3)
        self.assertEqual(len({c["headers"]["idempotency-key"] for c in calls}), 1)

    def test_encodes_the_actor_id_as_one_path_segment(self) -> None:
        self.assertEqual(runtime.path("/actors/Room/{id}/Post", "a/b c"), "/actors/Room/a%2Fb%20c/Post")
        self.assertEqual(runtime.path("/actors/Lobby/Join"), "/actors/Lobby/Join")


if __name__ == "__main__":
    unittest.main()
