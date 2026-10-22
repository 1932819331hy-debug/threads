"""The pure turn projection of already-validated log events (spec/trajectories.md)."""
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from pydantic import JsonValue

from threadsai.log.jcs import canonicalize
from threadsai.result import Err


def _object(value: JsonValue) -> dict[str, JsonValue]:
    if not isinstance(value, dict):
        raise TypeError("a validated event has object data")
    return value


@dataclass(frozen=True, slots=True)
class _Turn:
    opening: Mapping[str, JsonValue]
    messages: list[JsonValue] = field(default_factory=list)
    calls: list[JsonValue] = field(default_factory=list)
    results: list[JsonValue] = field(default_factory=list)

    def record(self, event: Mapping[str, JsonValue], compactions: set[str]) -> None:
        kind, data = event["type"], _object(event["data"])
        identity = {"event_id": event["event_id"], "seq": event["seq"]}
        if kind in ("user_input", "steer"):
            content = data.get("content", [{"type": "text", "text": data.get("text", "")}])
            self.messages.append({**identity, "role": "user", "content": content})
        elif kind in ("model_response", "model_response_recovered"):
            if data.get("request_event_id") not in compactions:
                self.messages.append({
                    **identity, "role": "assistant", "content": data["content"],
                    "completeness": data["completeness"], "stop_reason": data["stop_reason"],
                })
        elif kind == "message_received":
            self.messages.append({**identity, "role": "mail", "data": data})
        elif kind == "tool_call":
            self.calls.append({**identity, "data": data})
        elif kind in ("tool_result", "tool_result_late"):
            self.results.append({**identity, "type": kind, "data": data})

    def finish(self, event: Mapping[str, JsonValue]) -> bytes:
        line: JsonValue = {
            "format_version": 1, "thread_id": event["thread_id"], "branch_id": event["branch_id"],
            "trigger": {"type": self.opening["type"], "data": self.opening["data"]},
            "turn_id": self.opening["event_id"], "started_at": self.opening["time"],
            "completed_at": event["time"], "completion": event["data"],
            "messages": self.messages, "tool_calls": self.calls, "tool_results": self.results,
        }
        encoded = canonicalize(line)
        if isinstance(encoded, Err):
            raise ValueError(f"validated trajectory is not canonicalizable: {encoded.error}")
        return encoded.value.encode("utf-8") + b"\n"


@dataclass(frozen=True, slots=True)
class _History:
    compactions: set[str] = field(default_factory=set)
    late: dict[str, Mapping[str, JsonValue]] = field(default_factory=dict)

    def observe(self, event: Mapping[str, JsonValue]) -> None:
        if event["type"] == "model_request" and _object(event["data"]).get("purpose") == "compaction":
            self.compactions.add(_text(event["event_id"]))
        if event["type"] == "tool_result_late":
            self.late[_text(event["event_id"])] = event

    def start(self, event: Mapping[str, JsonValue]) -> _Turn:
        turn = _Turn(event)
        if event["type"] != "woken":
            return turn
        causes = _object(event["data"])["causes"]
        if not isinstance(causes, list):
            raise TypeError("a validated wake has causes")
        results = [self.late[cause] for cause in {_text(cause) for cause in causes}]
        for result in sorted(results, key=lambda item: _number(item["seq"])):
            turn.record(result, self.compactions)
        return turn


def project(
    events: Sequence[Mapping[str, JsonValue]], branch: str, inputs: Mapping[int, bool], *, since: int = 0
) -> bytes:
    """Keep closed turns whose completion belongs to this branch, in event order.

    The public exporter passes only events read through the verified store boundary.
    A child's inherited open turn can close here; its inherited completed turns cannot.
    """
    out: list[bytes] = []
    turn: _Turn | None = None
    history = _History()
    for index, event in enumerate(events):
        kind = event["type"]
        history.observe(event)
        if inputs.get(index):
            turn = history.start(event)
        if turn is None:
            continue
        if kind == "turn_completed":
            time = event["time"]
            if not isinstance(time, int):
                raise TypeError("a validated event has an integer time")
            if event["branch_id"] == branch and time >= since:
                out.append(turn.finish(event))
            turn = None
        elif kind != "message_received" or index in inputs:
            turn.record(event, history.compactions)
    return b"".join(out)


def _text(value: JsonValue) -> str:
    if not isinstance(value, str):
        raise TypeError("a validated event has an event id")
    return value


def _number(value: JsonValue) -> int:
    if not isinstance(value, int):
        raise TypeError("a validated event has an integer sequence")
    return value
