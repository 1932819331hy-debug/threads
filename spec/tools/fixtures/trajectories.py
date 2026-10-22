"""Generated trajectory vectors; logs use the same builders as conformance cases."""

from pathlib import Path

from .trajectory_turns import inputs, rows as turn_rows
from .common import BRANCH, CASES, obj, tokens
from .jcs import JsonValue, canonical
from .log import Log
from .pieces import READ_FILE, dump, read_turn, started, user

VECTOR = CASES.parent / "vectors" / "trajectories.json"


def rows(cases: Path = CASES) -> list[JsonValue]:
    log = Log()
    started(log, [READ_FILE])
    read_turn(log)
    first = list(log.events)
    u = user(log, "Unicode café 🌍")
    r = log.model_request()
    response = log.model_response(r, [{"type": "text", "text": "Done."}], "end_turn", tokens(3, 2))
    end = log.add("turn_completed", {"reason": "end_turn"})
    second: JsonValue = {
        "format_version": 1,
        "thread_id": log.thread,
        "branch_id": BRANCH,
        "turn_id": u["event_id"],
        "trigger": {"type": u["type"], "data": u["data"]},
        "started_at": u["time"],
        "completed_at": end["time"],
        "completion": end["data"],
        "messages": [
            {
                "role": "user", "event_id": u["event_id"], "seq": u["seq"],
                "content": [{"type": "text", "text": "Unicode café 🌍"}],
            },
            {
                "role": "assistant", "event_id": response["event_id"], "seq": response["seq"],
                "content": obj(response["data"])["content"],
                "completeness": "complete", "stop_reason": "end_turn",
            },
        ],
        "tool_calls": [],
        "tool_results": [],
    }
    # Reference expectations are explicitly assembled from the fixture's known steps.
    opening, call_response, tool_call, tool_result, answer, completion = [
        first[i] for i in (1, 3, 4, 6, 8, 9)
    ]
    first_row: JsonValue = {
        "format_version": 1,
        "thread_id": log.thread,
        "branch_id": BRANCH,
        "turn_id": opening["event_id"],
        "trigger": {"type": opening["type"], "data": opening["data"]},
        "started_at": opening["time"],
        "completed_at": completion["time"],
        "completion": completion["data"],
        "messages": [
            {
                "role": "user", "event_id": opening["event_id"], "seq": opening["seq"],
                "content": [{"type": "text", "text": obj(opening["data"])["text"]}],
            },
            *[
                {
                    "role": "assistant", "event_id": e["event_id"], "seq": e["seq"],
                    "content": obj(e["data"])["content"],
                    "completeness": obj(e["data"])["completeness"],
                    "stop_reason": obj(e["data"])["stop_reason"],
                }
                for e in (call_response, answer)
            ],
        ],
        "tool_calls": [
            {"event_id": tool_call["event_id"], "seq": tool_call["seq"], "data": tool_call["data"]}
        ],
        "tool_results": [
            {
                "event_id": tool_result["event_id"], "seq": tool_result["seq"],
                "type": tool_result["type"], "data": tool_result["data"],
            }
        ],
    }
    user(log, "Unfinished input")
    expected: list[JsonValue] = [first_row, second]
    return [{
        "name": "two-user-turns", "branch_id": BRANCH, "events": log.events, "log": log.export().decode(),
        "inputs": [[i, opens] for i, opens in inputs(log.events).items()],
        "expected": expected,
        "jsonl": b"".join(canonical(row) + b"\n" for row in expected).decode(),
    }, *turn_rows(cases)]


def write(cases: Path = CASES) -> None:
    VECTOR.write_text(dump(rows(cases)), encoding="utf-8")


def check(cases: Path = CASES) -> list[str]:
    current = VECTOR.exists() and VECTOR.read_text(encoding="utf-8") == dump(rows(cases))
    return [] if current else ["trajectories.json is stale"]
