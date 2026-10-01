"""Runs the served exchange corpus the TypeScript client also runs.

The corpus lives with the framework's wire protocol; both clients must treat
every exchange alike: the same attempts, one command id and body, the same
outcome, and waits within the same bounds.
"""

import json
import os
import unittest
from typing import Any, Dict, List

import runtime
from test_runtime import Clock, Stub

CORPUS = os.path.join(
    os.path.dirname(__file__), "..", "..", "durable-actors", "src", "protocol", "exchanges.json"
)


def load_cases() -> List[Dict[str, Any]]:
    with open(CORPUS, encoding="utf-8") as corpus:
        return json.load(corpus)["cases"]


class ExchangeTest(unittest.TestCase):
    def run_case(self, case: Dict[str, Any]) -> None:
        stub = Stub()
        self.addCleanup(stub.close)
        clock = Clock()
        now_ms = int(clock.now() * 1000)
        command_id = "v1.%d.%d.00000000-0000-4000-8000-000000000001" % (now_ms - 1000, now_ms + 60_000)
        stub.script = [self.answer(response, command_id) for response in case["responses"]]
        credentials = iter("credential-%d" % n for n in range(1, 100))
        client = runtime.Runtime(
            stub.url,
            protocol_path="/protocol",
            token=(lambda: next(credentials)) if case.get("refresh") else "credential",
            sleep=clock.sleep,
            now=clock.now,
            jitter=lambda: 0.0,
        )

        outcome = case["outcome"]
        try:
            result = client.call(
                "/actors/ExchangeVectors/room/Call", command=True, body={"text": "hi"}, command_id=command_id
            )
        except runtime.DeclaredError as declared:
            self.assertEqual(declared.tag, outcome.get("declared"))
        except runtime.Defect:
            self.assertTrue(outcome.get("defect"))
        except runtime.ActorError as error:
            self.assertEqual(error.tag, outcome.get("actorError"))
            if "code" in outcome:
                self.assertEqual(error.code, outcome["code"])
        else:
            self.assertIn("result", outcome)
            self.assertEqual(result, outcome["result"])

        calls = stub.calls()
        self.assertEqual(len(calls), case["attempts"])
        self.assertEqual({c["headers"]["idempotency-key"] for c in calls}, {command_id})
        self.assertEqual(len({c["body"] for c in calls}), 1)
        if case.get("freshCredentials"):
            self.assertEqual(len({c["headers"]["authorization"] for c in calls}), len(calls))

        waits = [seconds * 1000 for seconds in clock.sleeps]
        self.assertEqual(len(waits), case["attempts"] - 1)
        for index, least in enumerate(case.get("minWaitMs", [])):
            self.assertGreaterEqual(waits[index], least)
        for index, most in enumerate(case.get("maxWaitMs", [])):
            self.assertLessEqual(waits[index], most)

    @staticmethod
    def answer(response: Dict[str, Any], command_id: str) -> Any:
        if response.get("drop"):
            return "drop"
        headers = response.get("headers", {})
        if "text" in response:
            return (response.get("status", 200), response["text"].encode("utf-8"), headers)
        body = json.loads(json.dumps(response.get("body")).replace("$commandId", command_id))
        return (response.get("status", 200), body, headers)


def make_test(case: Dict[str, Any]) -> Any:
    return lambda self: self.run_case(case)


for number, exchange in enumerate(load_cases()):
    name = "test_%02d_%s" % (number, exchange["name"].replace(" ", "_")[:60])
    setattr(ExchangeTest, name, make_test(exchange))


if __name__ == "__main__":
    unittest.main()
