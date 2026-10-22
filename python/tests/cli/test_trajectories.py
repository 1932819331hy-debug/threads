"""Invalid export mode combinations never open the store."""

from unittest.mock import AsyncMock

import pytest
from trajectory_kit import finish

from threadsai.cli import main

USAGE_ERROR = 2


@pytest.mark.parametrize(
    "args",
    [
        ["export", "--jsonl", "branch"],
        ["export", "--jsonl", "--bundle", "dir"],
        ["export", "--thread", "thread"],
        ["export", "--since", "0"],
        ["export", "--jsonl", "--since", "-1"],
        ["export", "--jsonl", "--since", "9007199254740992"],
        ["export", "--jsonl", "--thread", "invalid"],
        ["export"],
    ],
)
def test_invalid_export_options(monkeypatch: pytest.MonkeyPatch, args: list[str]) -> None:
    monkeypatch.setattr("threadsai.cli.asyncio.run", finish)
    opened = AsyncMock(side_effect=AssertionError("invalid input opened the store"))
    monkeypatch.setattr("threadsai.trajectories.open_store", opened)
    assert main(args) == USAGE_ERROR
    opened.assert_not_called()
