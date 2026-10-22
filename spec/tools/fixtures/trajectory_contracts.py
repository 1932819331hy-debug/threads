"""Shared trajectory boundary contracts, not complete log/transition fixtures."""

from collections.abc import Callable
from copy import deepcopy

from .common import arr, obj
from .jcs import JsonValue, Obj


def rows(vectors: list[JsonValue]) -> list[JsonValue]:
    records = [obj(row) for vector in vectors for row in arr(obj(vector)["expected"])]
    user = next(row for row in records if obj(row["trigger"])["type"] == "user_input")
    mail = next(
        row
        for row in records
        if obj(row["trigger"])["type"] == "message_received"
        and obj(obj(obj(row["trigger"])["data"])["envelope"])["kind"] == "member_settled"
    )
    out: list[JsonValue] = [
        {"name": f"exported-record-{i}", "valid": True, "record": row}
        for i, row in enumerate(records)
    ]

    def add(name: str, valid: bool, base: Obj, edit: Callable[[Obj], None]) -> None:
        record = deepcopy(base)
        edit(record)
        out.append({"name": name, "valid": valid, "record": record})

    def input_case(name: str, valid: bool, data: Obj) -> None:
        add(name, valid, user, lambda r: obj(r["trigger"]).update(data=data))

    mail_id = f"{user['branch_id']}:contract"
    content: list[JsonValue] = [{"type": "text", "text": "content"}]
    api: Obj = {"source": "api", "text": "input"}
    a2a: Obj = {"message_id": "message", "context_id": "context"}
    input_case("missing-text-and-content", False, {"source": "api"})
    input_case("both-text-and-content", False, {**api, "content": content})
    input_case("content-only", True, {"source": "api", "content": content})
    input_case("team-task-missing-mail-id", False, {"source": "team_task", "text": "input"})
    input_case(
        "team-task-mail-id", True, {"source": "team_task", "text": "input", "mail_id": mail_id}
    )
    input_case("api-forbids-mail-id", False, {**api, "mail_id": mail_id})
    input_case("cli-forbids-a2a", False, {"source": "cli", "text": "input", "a2a": a2a})
    input_case("api-a2a", True, {**api, "a2a": a2a})
    input_case("empty-budget", False, {**api, "budget": {}})
    input_case("positive-budget", True, {**api, "budget": {"max_turns": 1}})
    input_case("zero-budget", False, {**api, "budget": {"max_turns": 0}})
    add("boolean-format-version", False, user, lambda r: r.update(format_version=True))
    add("extra-root-field", False, user, lambda r: r.update(unexpected=True))
    add(
        "non-error-completion-code",
        False,
        user,
        lambda r: r.update(completion={"reason": "end_turn", "code": "content_unsupported"}),
    )
    add(
        "error-completion-code",
        True,
        user,
        lambda r: r.update(completion={"reason": "error", "code": "content_unsupported"}),
    )
    add("error-completion-no-code", True, user, lambda r: r.update(completion={"reason": "error"}))

    def envelope(record: Obj) -> Obj:
        return obj(obj(obj(record["trigger"])["data"])["envelope"])

    def output(record: Obj, body: Obj) -> None:
        obj(envelope(record)["result"])["output"] = body

    artifact: Obj = {"sha256": "a" * 64, "bytes": 1, "media_type": "text/plain"}
    add("settled-mail-missing-result", False, mail, lambda r: envelope(r).__delitem__("result"))
    add("empty-text-body", False, mail, lambda r: output(r, {}))
    add("both-text-and-ref", False, mail, lambda r: output(r, {"text": "text", "ref": artifact}))
    add("text-body-inline", True, mail, lambda r: output(r, {"text": "text"}))
    add("text-body-ref", True, mail, lambda r: output(r, {"ref": artifact}))
    member = obj(envelope(mail)["result"])["member"]
    budget: Obj = {
        "scope": "ancestor",
        "limit": "max_turns",
        "limit_value": 1,
        "observed": 2,
        "observed_is_upper_bound": False,
    }

    def exhausted(name: str, valid: bool, value: Obj) -> None:
        add(
            name,
            valid,
            mail,
            lambda r: envelope(r).update(
                kind="member_ended",
                result={"member": member, "status": "budget_exhausted", "budget": value},
            ),
        )

    exhausted("ancestor-budget-missing-owner", False, budget)
    exhausted("ancestor-budget-owner", True, {**budget, "owner_thread_id": mail["thread_id"]})
    exhausted(
        "local-budget-forbids-owner",
        False,
        {**budget, "scope": "thread", "owner_thread_id": mail["thread_id"]},
    )
    exhausted("local-budget-no-owner", True, {**budget, "scope": "thread"})
    for media_type, valid in (("text/plain", False), ("image/png", True)):
        part: Obj = {
            "type": "image_ref",
            "ref": {**artifact, "media_type": media_type},
            "width": 1,
            "height": 1,
        }
        add(
            f"image-{media_type}",
            valid,
            user,
            lambda r, part=part: obj(arr(r["messages"])[0]).update(content=[part]),
        )
    return out
