import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { secret } from "../../src/agent/secret";
import { Store, storeOf } from "../../src/agent/sqlite";
import { ThreadId } from "../../src/log/ids";
import { JsonObject } from "../../src/log/primitives";
import { forgetSecrets } from "../../src/redact";
import { ok } from "../../src/result";
import type { ArtifactStore } from "../../src/store/artifacts";
import type { StoreDriver, Tx } from "../../src/store/driver";
import { LogStore } from "../../src/store/store";
import { exportTrajectories } from "../../src/trajectories";
import { project } from "../../src/trajectories/project";
import { Trajectory } from "../../src/trajectories/schema";
import { verifyExport } from "../../src/verify/verify";

const Vector = z.strictObject({ branch_id: z.string(), events: z.array(JsonObject),
  log: z.string(), expected: z.array(Trajectory), jsonl: z.string() });
const vectors = z.array(Vector).parse(JSON.parse(readFileSync(
  new URL("../../../../../spec/conformance/vectors/trajectories.json", import.meta.url), "utf8")));
const vector = vectors[0];
if (vector === undefined) throw new Error("missing trajectory vector");
const first = vector.expected[0];
if (first === undefined) throw new Error("missing expected trajectory");
const utf8 = new TextDecoder();

function forbidden(): never { throw new Error("unexpected DB, artifact or transport operation"); }

/** A real LogStore with a mocked driver/read; no database is opened. */
async function fixture(verified = 1): Promise<Store> {
  const log = verifyExport(new TextEncoder().encode(vector.log));
  if (!log.ok) throw new Error(log.error.message);
  const tx: Tx = { dialect: "sqlite", run: forbidden, transaction: forbidden, afterCommit: forbidden,
    all: async (sql, params) => {
      expect(sql).toContain("WHERE tenant_id = ?"); expect(params).toEqual(["tenant-a"]);
      return [{ thread_id: first.thread_id, branch_id: first.branch_id, head_verified: verified }];
    } };
  const driver: StoreDriver = { dialect: "sqlite", install: async () => ok(undefined), close: forbidden,
    transaction: async (run, options) => { expect(options?.readOnly).toBe(true); return run(tx); } };
  const artifacts: ArtifactStore = { put: forbidden, get: forbidden, sink: forbidden, sweep: forbidden };
  const opened = await LogStore.open(driver, () => 0, artifacts, "tenant-a");
  if (!opened.ok) throw new Error(opened.error.message);
  opened.value.read = async (id) => { expect(id).toBe(first.branch_id); return log; };
  return storeOf({ log: opened.value, artifacts });
}

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
  const child = first.branch_id.replace(/1$/, "2");
  const events = vector.events.map((event) => event["seq"] === 14 ? { ...event, branch_id: child } : event);
  const rows = utf8.decode(project(events, child)).trim().split("\n");
  expect(rows).toHaveLength(1);
  const row = Trajectory.parse(JSON.parse(rows[0] ?? "null"));
  expect(row.branch_id).toBe(child);
  expect(row.turn_id).toBe(vector.expected[1]?.turn_id);
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
