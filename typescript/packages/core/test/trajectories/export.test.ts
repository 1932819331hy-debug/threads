import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { secret } from "../../src/agent/secret";
import { Store, storeOf } from "../../src/agent/sqlite";
import { BranchId, ThreadId } from "../../src/log/ids";
import { JsonObject } from "../../src/log/primitives";
import { forgetSecrets } from "../../src/redact";
import { ok } from "../../src/result";
import type { ArtifactStore } from "../../src/store/artifacts";
import type { StoreDriver, Tx } from "../../src/store/driver";
import { LogStore } from "../../src/store/store";
import { exportTrajectories } from "../../src/trajectories";
import { turnInputs } from "../../src/fold/openers";
import { KnownEvent } from "../../src/log/events";
import { project as rawProject } from "../../src/trajectories/project";
import { Trajectory } from "../../src/trajectories/schema";
import { verifyExport } from "../../src/verify/verify";

const Vector = z.strictObject({ name: z.string(), inputs: z.array(z.tuple([z.int(), z.boolean()])), branch_id: z.string(), events: z.array(JsonObject),
  log: z.string(), expected: z.array(Trajectory), jsonl: z.string() });
const vectors = z.array(Vector).parse(JSON.parse(readFileSync(
  new URL("../../../../../spec/conformance/vectors/trajectories.json", import.meta.url), "utf8")));
const primary = vectors[0];
if (primary === undefined) throw new Error("missing trajectory vector");
const vector: z.infer<typeof Vector> = primary;
const first = vector.expected[0];
if (first === undefined) throw new Error("missing expected trajectory");
const utf8 = new TextDecoder();

function forbidden(): never { throw new Error("unexpected DB, artifact or transport operation"); }

/** A real LogStore with a mocked driver/read; no database is opened. */
async function fixture(verified = 1, selected: z.infer<typeof Vector> = vector): Promise<Store> {
  const log = verifyExport(new TextEncoder().encode(selected.log));
  if (!log.ok) throw new Error(log.error.message);
  const leaf = log.value.segments.at(-1)?.header;
  if (leaf === undefined) throw new Error("missing header");
  const tx: Tx = { dialect: "sqlite", run: forbidden, transaction: forbidden, afterCommit: forbidden,
    all: async (sql, params) => {
      expect(sql).toContain("WHERE tenant_id = ?"); expect(params).toEqual(["tenant-a"]);
      return [{ thread_id: leaf.thread_id, branch_id: leaf.branch_id, head_verified: verified }];
    } };
  const driver: StoreDriver = { dialect: "sqlite", install: async () => ok(undefined), close: forbidden,
    transaction: async (run, options) => { expect(options?.readOnly).toBe(true); return run(tx); } };
  const artifacts: ArtifactStore = { put: forbidden, get: forbidden, sink: forbidden, sweep: forbidden };
  const opened = await LogStore.open(driver, () => 0, artifacts, "tenant-a");
  if (!opened.ok) throw new Error(opened.error.message);
  opened.value.read = async (id) => { expect(id).toBe(leaf.branch_id); return log; };
  return storeOf({ log: opened.value, artifacts });
}

function project(events: readonly JsonObject[], branch: string): Uint8Array {
  return rawProject(events, branch, turnInputs(events.map((e) => KnownEvent.parse(e))));
}

test.each(vectors)("all turn inputs and exact bytes: $name", async (selected) => {
  const known = selected.events.map((e) => KnownEvent.parse(e));
  expect([...turnInputs(known)]).toEqual(selected.inputs);
  expect(new TextDecoder().decode(project(selected.events, selected.branch_id))).toBe(selected.jsonl);
  const output = await exportTrajectories(await fixture(1, selected));
  expect(output.ok && new TextDecoder().decode(output.value)).toBe(selected.jsonl);
});

afterEach(() => { forgetSecrets(); delete process.env["TRAJECTORY_TEST_SECRET"]; });

test("two closed turns, tools and Unicode match shared canonical bytes; unfinished tail is absent", async () => {
  const result = await exportTrajectories(await fixture());
  expect(result.ok && utf8.decode(result.value)).toBe(vector.jsonl);
  expect(utf8.decode(project(vector.events, vector.branch_id))).toBe(vector.jsonl);
});

test("since is inclusive; future and empty selection have zero lines", async () => {
  const store = await fixture();
  const at = vector.expected[1]?.completed_at;
  if (at === undefined) throw new Error("missing completion");
  const result = await exportTrajectories(store, { threads: [first.thread_id, first.thread_id], since: at });
  expect(result.ok && utf8.decode(result.value).split("\n").filter(Boolean)).toHaveLength(1);
  expect(await exportTrajectories(store, { since: at + 1 })).toEqual(ok(new Uint8Array()));
  expect(await exportTrajectories(new Store("must-not-open"), { threads: [] })).toEqual(ok(new Uint8Array()));
});

test("unknown and foreign thread ids return the same scoped not_found", async () => {
  const store = await fixture();
  const result = await exportTrajectories(store, { threads: [ThreadId.parse(first.thread_id.replace(/1$/, "2"))] });
  expect(!result.ok && result.error.code).toBe("not_found");
});

test("invalid option times and an unverified branch are refused", async () => {
  const store = await fixture();
  for (const since of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])
    await expect(exportTrajectories(store, { since })).rejects.toThrow("invalid trajectory options");
  const result = await exportTrajectories(await fixture(0));
  expect(!result.ok && result.error.code).toBe("head_mismatch");
});

test("secret() values fail closed rather than leaking training bytes", async () => {
  // A synthetic value placed in the fixture log before registration models a bad stored value.
  process.env["TRAJECTORY_TEST_SECRET"] = "README.md";
  secret("TRAJECTORY_TEST_SECRET").reveal();
  const result = await exportTrajectories(await fixture());
  expect(!result.ok && result.error.code).toBe("secret_in_stored_bytes");
  expect(JSON.stringify(result)).not.toContain("README.md");
});

test("ancestor completions and an incomplete turn do not create rows", () => {
  expect(project(vector.events, first.branch_id.replace(/1$/, "2"))).toEqual(new Uint8Array());
  expect(project(vector.events.slice(0, 2), first.branch_id)).toEqual(new Uint8Array());
});

test("a child closes an inherited open turn without replaying its parent's completions", () => {
  const child = BranchId.parse(first.branch_id.replace(/1$/, "2"));
  const expected = vector.expected[1];
  if (expected === undefined) throw new Error("missing inherited-turn trajectory");
  const events = vector.events.map((event) => event["seq"] === 14 ? { ...event, branch_id: child } : event);
  const rows = utf8.decode(project(events, child)).trim().split("\n");
  expect(rows).toHaveLength(1);
  const row = Trajectory.parse(JSON.parse(rows[0] ?? "null"));
  expect(row.branch_id).toBe(child);
  expect(row.turn_id).toBe(expected.turn_id);
});

test("failed completions are retained; compaction responses are omitted", () => {
  const events = vector.events.map((event) => {
    const data = JsonObject.parse(event["data"]);
    if (event["seq"] === 3) return { ...event, data: { ...data, purpose: "compaction" } };
    if (event["seq"] === 10) return { ...event, data: { reason: "error", code: "content_unsupported" } };
    return event;
  });
  const row = Trajectory.parse(JSON.parse(utf8.decode(project(events, first.branch_id)).split("\n")[0] ?? "null"));
  expect(row.messages).toHaveLength(2);
  expect(row.completion.reason).toBe("error");
});

test("registered credentials absent from the log remain absent from a successful export", async () => {
  process.env["TRAJECTORY_TEST_SECRET"] = "synthetic-api-credential-000";
  secret("TRAJECTORY_TEST_SECRET").reveal();
  const result = await exportTrajectories(await fixture());
  expect(result.ok).toBe(true);
  expect(JSON.stringify(result)).not.toContain("synthetic-api-credential-000");
});

test("mail blocked by another park and wait-settle mail do not open turns", () => {
  const parked = vectors.find((v) => v.name === "run-member-parks-then-final-answer/log.jsonl");
  const team = vectors.find((v) => v.name === "team-operator-start-and-wait/logs/team.jsonl");
  if (parked === undefined || team === undefined) throw new Error("missing input vectors");
  const events = parked.events.map((e) => KnownEvent.parse(e));
  const park = events.find((e) => e.type === "parked");
  const notice = events.find((e) => e.type === "message_received" && e.data.envelope.kind === "member_settled");
  const wait = team.events.map((e) => KnownEvent.parse(e)).find((e) => e.type === "wait_started");
  if (park?.type !== "parked" || notice?.type !== "message_received" || wait?.type !== "wait_started")
    throw new Error("missing park or notice");
  const other = KnownEvent.parse({ ...park, data: { ...park.data,
    address: { kind: "member", id: `${park.data.address.id}-other` } } });
  expect([...turnInputs([park, notice])]).toEqual([[1, true]]);
  expect([...turnInputs([park, other, notice])]).toEqual([[2, false]]);
  const member = wait.data.members[0];
  if (member === undefined) throw new Error("missing wait member");
  const settlement = KnownEvent.parse({ ...notice, data: { ...notice.data,
    envelope: { ...notice.data.envelope, monitor_id: `${wait.branch_id}:${wait.event_id}:${member.name}` } } });
  expect([...turnInputs([wait, settlement])]).toEqual([]);
});
