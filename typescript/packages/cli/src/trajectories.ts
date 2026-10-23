import { exportTrajectories, type Store } from "threadsai";
import { ThreadId } from "threadsai/host";
import type { Io } from "./cli";

export type TrajectoryArgs = {
  readonly jsonl: boolean;
  readonly threads: readonly string[] | undefined;
  readonly since: string | undefined;
};

/** Check before opening the store; configuration failures are CLI usage errors. */
export async function trajectories(
  args: TrajectoryArgs,
  open: () => Promise<Store>,
  io: Io,
): Promise<number> {
  const threads =
    args.threads === undefined
      ? undefined
      : ThreadId.array().safeParse(args.threads);
  const since = args.since === undefined ? undefined : Number(args.since);
  if (
    (threads !== undefined && !threads.success) ||
    (since !== undefined &&
      (!/^\d+$/.test(args.since ?? "") ||
        !Number.isSafeInteger(since) ||
        since < 0))
  ) {
    io.err("invalid trajectory --thread or --since\n");
    return 2;
  }
  const result = await exportTrajectories(await open(), {
    ...(threads?.success ? { threads: threads.data } : {}),
    ...(since === undefined ? {} : { since }),
  });
  if (!result.ok) {
    io.err(`${result.error.code}: ${result.error.message}\n`);
    return 1;
  }
  io.bytes(result.value);
  return 0;
}
