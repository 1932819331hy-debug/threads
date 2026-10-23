"""Positive and negative trajectory contracts are shared with TypeScript."""

import json
from pathlib import Path

import pytest
from pydantic import JsonValue, TypeAdapter, ValidationError

from threadsai._generated.trajectory_v1 import Trajectory

VECTOR = Path(__file__).resolve().parents[3] / "spec/conformance/vectors/trajectory-contracts.json"
CASES = TypeAdapter(list[dict[str, JsonValue]]).validate_json(VECTOR.read_bytes())


@pytest.mark.parametrize("case", CASES, ids=[str(case["name"]) for case in CASES])
def test_shared_schema_contract(case: dict[str, JsonValue]) -> None:
    raw = json.dumps(case["record"])
    if case["valid"] is True:
        Trajectory.model_validate_json(raw)
    else:
        with pytest.raises(ValidationError):
            Trajectory.model_validate_json(raw)
