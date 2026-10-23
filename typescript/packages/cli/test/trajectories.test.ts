import { expect, test } from "bun:test";
import { type Io, run } from "../src/cli";

const forbidden = (): never => {
  throw new Error("invalid arguments cannot emit bytes");
};
const io: Io = { out: forbidden, bytes: forbidden, err: () => {} };

for (const args of [
  ["export", "--jsonl", "branch"],
  ["export", "--jsonl", "--bundle", "dir"],
  ["export", "--thread", "thread"],
  ["export", "--since", "0"],
  ["export", "--jsonl", "--since", "-1"],
  ["export", "--jsonl", "--since", "9007199254740992"],
  ["export", "--jsonl", "--thread", "invalid"],
  ["timeline", "--jsonl"],
])
  test(`usage is checked before store open: ${args.join(" ")}`, async () => {
    expect(await run(args, io)).toBe(2);
  });
