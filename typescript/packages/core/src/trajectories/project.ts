import type { JsonObject } from "../log/primitives";
import { canonicalize, type Json } from "../log/jcs";

export class ProjectionError extends Error {}

/** Pure projection after the store's schema/chain validation (spec/trajectories.md). */
export function project(
  events: readonly JsonObject[],
  branch: string,
  since = 0,
): Uint8Array {
  const lines: string[] = [];
  const compactions = new Set<string>();
  let turn: Turn | undefined;
  for (const event of events) {
    const kind = event["type"];
    if (kind === "model_request" && object(event["data"])["purpose"] === "compaction")
      compactions.add(text(event["event_id"]));
    if (kind === "user_input") turn = new Turn(event);
    if (turn === undefined) continue;
    if (kind === "turn_completed") {
      const time = event["time"];
      if (typeof time !== "number") throw new Error("a validated event has a time");
      if (event["branch_id"] === branch && time >= since) lines.push(turn.finish(event));
      turn = undefined;
    } else turn.record(event, compactions);
  }
  return new TextEncoder().encode(lines.join(""));
}

class Turn {
  readonly opening: JsonObject;
  readonly messages: Json[] = [];
  readonly calls: Json[] = [];
  readonly results: Json[] = [];

  constructor(opening: JsonObject) { this.opening = opening; }

  record(event: JsonObject, compactions: ReadonlySet<string>): void {
    const kind = event["type"];
    const data = object(event["data"]);
    const identity = { event_id: event["event_id"], seq: event["seq"] };
    if (kind === "user_input" || kind === "steer") {
      const content = data["content"] ?? [{ type: "text", text: data["text"] ?? "" }];
      this.messages.push({ ...identity, role: "user", content });
    } else if (kind === "model_response" || kind === "model_response_recovered") {
      if (!compactions.has(text(data["request_event_id"])))
        this.messages.push({ ...identity, role: "assistant", content: data["content"],
          completeness: data["completeness"], stop_reason: data["stop_reason"] });
    } else if (kind === "tool_call") this.calls.push({ ...identity, data });
    else if (kind === "tool_result" || kind === "tool_result_late")
      this.results.push({ ...identity, type: kind, data });
  }

  finish(event: JsonObject): string {
    const line = canonicalize({
      format_version: 1, thread_id: event["thread_id"], branch_id: event["branch_id"],
      turn_id: this.opening["event_id"], started_at: this.opening["time"],
      completed_at: event["time"], completion: event["data"],
      messages: this.messages, tool_calls: this.calls, tool_results: this.results,
    });
    if (!line.ok) throw new ProjectionError(`trajectory is not canonicalizable: ${line.error.message}`);
    return `${line.value}\n`;
  }
}

function object(value: JsonObject[string] | undefined): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("a validated event has object data");
  return value;
}

function text(value: Json | undefined): string {
  if (typeof value !== "string") throw new Error("a validated event has an id");
  return value;
}
