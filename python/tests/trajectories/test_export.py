"""The shared vectors pin exact bytes. All store operations below are mocks, no DB."""
from collections.abc import Callable, Iterable
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from trajectory_kit import finish
from pydantic import JsonValue, TypeAdapter

from threadsai import export_trajectories, secret
from threadsai._generated.trajectory_v1 import TrajectoryBranch
from threadsai.agents.config import ConfigError
from threadsai.agents.store import Store
from threadsai.log import BranchId, ThreadId
from threadsai.redaction import forget_secrets
from threadsai.result import Err, Ok
from threadsai.secrets import resolve
from threadsai.store.conn import Conn, Cursor, Params
from threadsai.store.verify import verify_export
from threadsai.trajectories.project import project

ROOT = Path(__file__).resolve().parents[3]
VECTOR = ROOT / "spec/conformance/vectors/trajectories.json"
_JSON = TypeAdapter(list[dict[str, JsonValue]])


def vector() -> dict[str, JsonValue]:
    return _JSON.validate_json(VECTOR.read_bytes())[0]


def events(value: dict[str, JsonValue]) -> list[dict[str, JsonValue]]:
    return _JSON.validate_python(value["events"])


def text(value: JsonValue) -> str:
    assert isinstance(value, str)
    return value


class Rows:
    rowcount = 1

    def __init__(self, verified: int) -> None:
        self.verified = verified

    def fetchall(self) -> list[tuple[object, ...]]:
        first = events(vector())[0]
        return [(first["branch_id"], first["thread_id"], self.verified)]

    def fetchone(self) -> tuple[object, ...] | None:
        return self.fetchall()[0]


class FakeConn(Conn):
    def __init__(self, verified: int) -> None:
        super().__init__()
        self.depth = 1
        self.verified = verified

    def _execute(self, sql: str, params: Params) -> Cursor:
        assert "WHERE tenant_id = ?" in sql
        assert params == ("tenant-a",)
        return Rows(self.verified)

    def _executemany(self, sql: str, rows: Iterable[Params]) -> None:
        raise AssertionError("no writes")

    def begin(self, *, read_only: bool = False) -> None:
        raise AssertionError("no DB")

    def commit(self) -> None:
        raise AssertionError("no DB")

    def rollback(self) -> None:
        raise AssertionError("no DB")

    def close(self) -> None:
        raise AssertionError("no DB")


class FakeStore:
    def __init__(self, verified: int) -> None:
        self.verified = verified

    async def run(
        self, fn: Callable[[Conn], tuple[TrajectoryBranch, ...]], *, read_only: bool
    ) -> tuple[TrajectoryBranch, ...]:
        assert read_only
        return fn(FakeConn(self.verified))

    async def read(self, branch: BranchId, now: int) -> object:
        v = vector()
        assert branch == v["branch_id"]
        return verify_export(text(v["log"]).encode(), now)


def store(monkeypatch: pytest.MonkeyPatch, verified: int = 1) -> Store:
    monkeypatch.setattr(
        "threadsai.trajectories.open_store", AsyncMock(return_value=FakeStore(verified))
    )
    return Store("must-not-open", tenant="tenant-a")


def test_shared_bytes_and_unfinished_tail(monkeypatch: pytest.MonkeyPatch) -> None:
    v = vector()
    result = finish(export_trajectories(store(monkeypatch)))
    assert isinstance(result, Ok)
    assert result == Ok(text(v["jsonl"]).encode())
    assert project(events(v), text(v["branch_id"])) == result.value


def test_since_empty_and_tenant_selection(monkeypatch: pytest.MonkeyPatch) -> None:
    s, v = store(monkeypatch), vector()
    expected = _JSON.validate_python(v["expected"])
    at = expected[1]["completed_at"]
    assert isinstance(at, int)
    tid = ThreadId(text(expected[0]["thread_id"]))
    result = finish(export_trajectories(s, threads=(tid, tid), since=at))
    assert isinstance(result, Ok)
    assert len(result.value.splitlines()) == 1
    assert finish(export_trajectories(s, since=at + 1)) == Ok(b"")
    assert finish(export_trajectories(Store("must-not-open"), threads=())) == Ok(b"")
    foreign = finish(export_trajectories(s, threads=(ThreadId(str(tid)[:-1] + "2"),)))
    assert isinstance(foreign, Err) and foreign.error.code == "not_found"


def test_unverified_head(monkeypatch: pytest.MonkeyPatch) -> None:
    result = finish(export_trajectories(store(monkeypatch, 0)))
    assert isinstance(result, Err) and result.error.code == "head_mismatch"


@pytest.mark.parametrize("since", [-1, 2**53])
def test_invalid_time(monkeypatch: pytest.MonkeyPatch, since: int) -> None:
    with pytest.raises(ConfigError):
        finish(export_trajectories(store(monkeypatch), since=since))


def test_secret_values_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    resolve(secret("TRAJECTORY_TEST_SECRET"), {"TRAJECTORY_TEST_SECRET": "README.md"})
    try:
        result = finish(export_trajectories(store(monkeypatch)))
        assert isinstance(result, Err) and result.error.code == "secret_in_stored_bytes"
        assert "README.md" not in repr(result)
    finally:
        forget_secrets()


def test_inherited_completions_and_input_only() -> None:
    v = vector()
    assert project(events(v), text(v["branch_id"])[:-1] + "2") == b""
    assert project(events(v)[:2], text(v["branch_id"])) == b""


def test_child_closes_inherited_turn() -> None:
    v = vector()
    child = text(v["branch_id"])[:-1] + "2"
    changed = [{**e, "branch_id": child} if e["seq"] == 14 else e for e in events(v)]
    rows = project(changed, child).splitlines()
    assert len(rows) == 1
    result = TypeAdapter(dict[str, JsonValue]).validate_json(rows[0])
    assert result["branch_id"] == child
    assert result["turn_id"] == _JSON.validate_python(v["expected"])[1]["turn_id"]


def test_failed_completion_and_compaction() -> None:
    v = vector()
    changed = events(v)
    request = changed[2]["data"]
    assert isinstance(request, dict)
    request["purpose"] = "compaction"
    changed[9]["data"] = {"reason": "error", "code": "content_unsupported"}
    first = project(changed, text(v["branch_id"])).splitlines()[0]
    result = TypeAdapter(dict[str, JsonValue]).validate_json(first)
    assert result["completion"] == changed[9]["data"]
    messages = result["messages"]
    assert isinstance(messages, list) and len(messages) == 2


def test_registered_secret_is_absent_from_success(monkeypatch: pytest.MonkeyPatch) -> None:
    resolve(
        secret("TRAJECTORY_TEST_SECRET"),
        {"TRAJECTORY_TEST_SECRET": "synthetic-api-credential-000"},
    )
    try:
        result = finish(export_trajectories(store(monkeypatch)))
        assert isinstance(result, Ok)
        assert b"synthetic-api-credential-000" not in result.value
    finally:
        forget_secrets()
