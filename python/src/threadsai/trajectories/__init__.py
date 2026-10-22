"""Completed-turn training export; the byte format is spec/trajectories.md."""
from collections.abc import Sequence

from pydantic import JsonValue, TypeAdapter, ValidationError
from pydantic.experimental.missing_sentinel import MISSING

from threadsai._generated.trajectory_v1 import TrajectoryBranch, TrajectoryOptions
from threadsai.agents.config import ConfigError
from threadsai.agents.store import Store, now_ms, open_store
from threadsai.log import BranchId, Event, ParseError, UnknownEvent
from threadsai.redaction import contains_secret
from threadsai.reduce.handlers import to_json
from threadsai.reduce.openers import turn_inputs
from threadsai.result import Err, Ok
from threadsai.store import SqliteStore
from threadsai.store.conn import Conn
from threadsai.trajectories.project import project

_OPTIONS = TypeAdapter(TrajectoryOptions)
_BRANCH = TypeAdapter(TrajectoryBranch)
_OBJECT = TypeAdapter(dict[str, JsonValue])


def _options(threads: Sequence[str] | None, since: int | None) -> TrajectoryOptions:
    options: dict[str, JsonValue] = {}
    if threads is not None:
        options["threads"] = list(threads)
    if since is not None:
        options["since"] = since
    try:
        return _OPTIONS.validate_python(options)
    except ValidationError as error:
        raise ConfigError("invalid_config", "invalid trajectory options") from error


async def _branches(
    opened: SqliteStore, tenant: str
) -> Ok[tuple[TrajectoryBranch, ...]] | Err[ParseError]:
    def select(conn: Conn) -> tuple[TrajectoryBranch, ...]:
        rows = conn.execute(
            "SELECT branch_id, thread_id, head_verified FROM branches WHERE tenant_id = ? "
            "AND state NOT IN ('forking', 'fork_failed') ORDER BY thread_id, branch_id",
            (tenant,),
        ).fetchall()
        keys = ("branch_id", "thread_id", "head_verified")
        return tuple(_BRANCH.validate_python(dict(zip(keys, row, strict=True))) for row in rows)

    try:
        return Ok(await opened.run(select, read_only=True))
    except (ValidationError, ValueError) as error:
        return Err(ParseError("log_corrupt", f"invalid trajectory index: {type(error).__name__}"))


async def _branch(
    opened: SqliteStore, row: TrajectoryBranch, since: int
) -> Ok[bytes] | Err[ParseError]:
    if not row.head_verified:
        return Err(ParseError("head_mismatch", "trajectory branch has no verified head"))
    read = await opened.read(BranchId(row.branch_id), now_ms())
    if isinstance(read, Err):
        return read
    if not read.value.head_verified:
        return Err(ParseError("head_mismatch", "trajectory branch has no verified head"))
    leaf = read.value.segments[-1].header
    if leaf.thread_id != row.thread_id or leaf.branch_id != row.branch_id:
        return Err(ParseError("log_corrupt", "trajectory index does not match verified log"))
    events: list[dict[str, JsonValue]] = []
    known: list[Event] = []
    for segment in read.value.segments:
        for event, _ in segment.events:
            if isinstance(event, UnknownEvent):
                continue
            events.append(_OBJECT.validate_python(to_json(event)))
            known.append(event)
    try:
        return Ok(project(events, row.branch_id, turn_inputs(known), since=since))
    except ValueError:
        return Err(ParseError("invalid_line", "trajectory cannot be represented as canonical JSON"))


async def export_trajectories(
    store: Store, *, threads: Sequence[str] | None = None, since: int | None = None
) -> Ok[bytes] | Err[ParseError]:
    """Export closed turns owned by this Store's tenant, or a typed read failure.

    `since` is inclusive completion time in epoch milliseconds. An empty selection
    emits no bytes. Invalid options raise ConfigError before opening the store.
    """
    parsed = _options(threads, since)
    wanted = None if parsed.threads is MISSING else frozenset(parsed.threads)
    if wanted == frozenset():
        return Ok(b"")
    opened = await open_store(store)
    branches = await _branches(opened, store.tenant)
    if isinstance(branches, Err):
        return branches
    if wanted is not None and wanted.difference(row.thread_id for row in branches.value):
        return Err(ParseError("not_found", "a selected thread was not found"))
    chunks: list[bytes] = []
    for row in branches.value:
        if wanted is not None and row.thread_id not in wanted:
            continue
        chunk = await _branch(opened, row, 0 if parsed.since is MISSING else parsed.since)
        if isinstance(chunk, Err):
            return chunk
        chunks.append(chunk.value)
    data = b"".join(chunks)
    if contains_secret(data):
        return Err(ParseError("secret_in_stored_bytes", "trajectory contains a registered secret"))
    return Ok(data)
