"""Export local completed turns: python examples/export_trajectories.py STORE [SINCE_MS].

Reads the local tenant only. It makes no model or tool calls. Stdout is training JSONL;
see spec/trajectories.md for the provider-neutral format and filtering semantics.
"""
import asyncio
import sys

from threadsai import export_trajectories, sqlite
from threadsai.result import Err


async def main() -> int:
    result = await export_trajectories(
        sqlite(sys.argv[1]), since=int(sys.argv[2]) if len(sys.argv) > 2 else None
    )
    if isinstance(result, Err):
        print(f"{result.error.code}: {result.error.message}", file=sys.stderr)
        return 1
    sys.stdout.buffer.write(result.value)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
