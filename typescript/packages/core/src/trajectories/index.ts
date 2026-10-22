import { ConfigError } from "../agent/errors";
import { openStore, type Store } from "../agent/sqlite";
import { turnInputs } from "../fold/openers";
import type { KnownEvent } from "../log";
import { JsonObject } from "../log/primitives";
import { containsSecret } from "../redact";
import { err, ok, type Result } from "../result";
import { READ_ONLY } from "../store/driver";
import { parseRows } from "../store/tables";
import { type LogError, logError } from "../verify/error";
import { project, ProjectionError } from "./project";
import { TrajectoryBranch, TrajectoryOptions } from "./schema";

export type { Trajectory, TrajectoryOptions } from "./schema";

/** Completed turns as canonical UTF-8 JSONL; see spec/trajectories.md. */
export async function exportTrajectories(
  store: Store,
  options: Readonly<TrajectoryOptions> = {},
): Promise<Result<Uint8Array, LogError>> {
  const parsed = TrajectoryOptions.safeParse(options);
  if (!parsed.success) throw new ConfigError("invalid_config", "invalid trajectory options");
  const wanted = parsed.data.threads === undefined ? undefined : new Set(parsed.data.threads);
  if (wanted?.size === 0) return ok(new Uint8Array());
  const { log } = await openStore(store);
  const branches = await log.driver.transaction(async (tx) => parseRows(
    TrajectoryBranch,
    await tx.all("SELECT branch_id, thread_id, head_verified FROM branches WHERE tenant_id = ? AND state NOT IN ('forking', 'fork_failed') ORDER BY thread_id, branch_id", [log.tenant]),
  ), READ_ONLY);
  if (!branches.ok) return branches;
  if (wanted !== undefined && [...wanted].some((id) => !branches.value.some((row) => row.thread_id === id)))
    return err(logError("not_found", "a selected thread was not found"));
  const chunks: Uint8Array[] = [];
  for (const row of branches.value) {
    if (wanted !== undefined && !wanted.has(row.thread_id)) continue;
    if (!row.head_verified) return err(logError("head_mismatch", "trajectory branch has no verified head"));
    const read = await log.read(row.branch_id);
    if (!read.ok) return read;
    if (!read.value.headVerified) return err(logError("head_mismatch", "trajectory branch has no verified head"));
    const leaf = read.value.segments.at(-1);
    if (leaf?.header.thread_id !== row.thread_id || leaf.header.branch_id !== row.branch_id)
      return err(logError("log_corrupt", "trajectory index does not match verified log"));
    const events = [];
    const known: KnownEvent[] = [];
    for (const line of read.value.events) {
      if (line.kind !== "event") continue;
      const event = JsonObject.safeParse(line.event);
      if (!event.success) return err(logError("log_corrupt", "invalid stored event"));
      events.push(event.data);
      known.push(line.event);
    }
    try { chunks.push(project(events, row.branch_id, turnInputs(known), parsed.data.since)); }
    catch (error) {
      if (error instanceof ProjectionError) return err(logError("invalid_line", "trajectory cannot be represented as canonical JSON"));
      throw error;
    }
  }
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return containsSecret(bytes)
    ? err(logError("secret_in_stored_bytes", "trajectory contains a registered secret"))
    : ok(bytes);
}
