"""Reference trajectory rows for existing wake, mail and incomplete-turn logs."""
from pathlib import Path
import json

from .common import arr, obj, text
from .jcs import JsonValue, Obj, canonical
from .turn_open import mail_opens_turn, mail_renders

# Expected counts are independent pins, not inferred from the implementation.
CASES = {
    "legacy-run-final-answer-after-wake/log.jsonl": 3,
    "run-final-answer-after-wake/log.jsonl": 2,
    "run-wake-turn-fails-after-answer/log.jsonl": 2,
    "run-member-parks-then-final-answer/log.jsonl": 2,
    "legacy-late-result-after-lead-ended-no-wake/log.jsonl": 1,
    "run-member-parks/log.jsonl": 1,
    "run-operator-member-does-not-extend/log.jsonl": 1,
    "woken-principal-mail-run/log.jsonl": 2,
    "render-team-message-lines/log.jsonl": 4,
    "host-caller-ask-answered/logs/support.jsonl": 1,
    "host-caller-ask-answered/logs/billing.jsonl": 1,
    "host-ask-across-restart-never-stale/logs/support.jsonl": 1,
    "team-operator-start-and-wait/logs/team.jsonl": 0,
}


def inputs(events: list[Obj]) -> dict[int, bool]:
    """The spec's existing turn/mail rules; the exporters use their own typed folds."""
    result: dict[int, bool] = {}
    if events and events[0]["type"] == "team_opened":
        return result
    opened = False
    parks: list[JsonValue] = []
    settle: set[str] = set()
    for i, event in enumerate(events):
        kind, data = event["type"], obj(event["data"])
        mail = kind == "message_received"
        env = obj(data["envelope"]) if mail else {}
        opens = not opened and (
            kind in ("user_input", "woken") or (mail and mail_opens_turn(env, settle, parks))
        )
        if opens:
            opened = True
        if opens or (mail and mail_renders(env, settle)):
            result[i] = opens
        if kind == "turn_completed":
            opened = False
        elif kind == "parked":
            parks.append(data["address"])
        elif kind == "resumed":
            parks.remove(data["address"])
        elif kind == "wait_started":
            settle.update(
                f"{event['branch_id']}:{event['event_id']}:{obj(m)['name']}"
                for m in arr(data["members"])
            )
    return result


def _row(events: list[Obj], start: int, end: int, ins: dict[int, bool]) -> Obj:
    opening, completion = events[start], events[end]
    messages: list[JsonValue] = []
    calls: list[JsonValue] = []
    results: list[JsonValue] = []
    causes = arr(obj(opening["data"])["causes"]) if opening["type"] == "woken" else []
    chosen = [(i, e) for i, e in enumerate(events[:end]) if i >= start or e["event_id"] in causes]
    for i, event in chosen:
        data, kind = obj(event["data"]), event["type"]
        identity: Obj = {"event_id": event["event_id"], "seq": event["seq"]}
        if kind in ("user_input", "steer"):
            messages.append({**identity, "role": "user", "content": data.get(
                "content", [{"type": "text", "text": data.get("text", "")}]
            )})
        elif kind in ("model_response", "model_response_recovered"):
            messages.append({**identity, "role": "assistant", "content": data["content"],
                             "completeness": data["completeness"], "stop_reason": data["stop_reason"]})
        elif kind == "message_received" and i in ins:
            messages.append({**identity, "role": "mail", "data": data})
        elif kind == "tool_call":
            calls.append({**identity, "data": data})
        elif kind in ("tool_result", "tool_result_late"):
            results.append({**identity, "type": kind, "data": data})
    return {
        "format_version": 1, "thread_id": completion["thread_id"],
        "branch_id": completion["branch_id"], "turn_id": opening["event_id"],
        "trigger": {"type": opening["type"], "data": opening["data"]},
        "started_at": opening["time"], "completed_at": completion["time"],
        "completion": completion["data"], "messages": messages,
        "tool_calls": calls, "tool_results": results,
    }


def rows(root: Path) -> list[JsonValue]:
    out: list[JsonValue] = []
    for path, count in CASES.items():
        raw = (root / path).read_text()
        events = [obj(json.loads(line)) for line in raw.splitlines() if "type" in obj(json.loads(line))]
        ins = inputs(events)
        expected: list[JsonValue] = []
        start: int | None = None
        for i, event in enumerate(events):
            if ins.get(i):
                start = i
            if event["type"] == "turn_completed":
                assert start is not None, path
                expected.append(_row(events, start, i, ins))
                start = None
        assert len(expected) == count, (path, len(expected), count)
        out.append({
            "name": path, "branch_id": text(events[-1]["branch_id"]),
            "events": events, "log": raw, "inputs": [[i, opens] for i, opens in ins.items()],
            "expected": expected, "jsonl": b"".join(canonical(row) + b"\n" for row in expected).decode(),
        })
    return out
