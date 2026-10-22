"""Drive fully mocked async trajectory operations without even a loop's socketpair."""
from collections.abc import Coroutine


def finish[T](work: Coroutine[object, object, T]) -> T:
    values: list[T] = []

    async def capture() -> None:
        values.append(await work)

    task = capture()
    try:
        task.send(None)
    except StopIteration:
        return values[0]
    finally:
        task.close()
    raise AssertionError("a mocked operation unexpectedly suspended")
