import { canonicalize, type Json } from "../log/jcs";
import type { JsonObject } from "../log/primitives";

export class ProjectionError extends Error {}

/** Pure projection after the store's schema/chain validation (spec/trajectories.md). */
export function project(
  events: readonly JsonObject[],
  branch: string,
  inputs: ReadonlyMap<number, boolean>,
  since = 0,
): Uint8Array {
  const lines: string[] = [];
  const history = new History();
  let turn: Turn | undefined;
  for (const [index, event] of events.entries()) {
    const kind = event["type"];
    history.observe(event);
    if (inputs.get(index)) turn = history.start(event);
    if (turn === undefined) continue;
    if (kind === "turn_completed") {
      const line = turn.completedLine(event, branch, since);
      if (line !== undefined) lines.push(line);
      turn = undefined;
    } else if (kind !== "message_received" || inputs.has(index))
      turn.record(event, history.compactions);
  }
  return new TextEncoder().encode(lines.join(""));
}

class History {
  readonly compactions = new Set<string>();
  readonly late = new Map<string, JsonObject>();

  observe(event: JsonObject): void {
    if (
      event["type"] === "model_request" &&
      object(event["data"])["purpose"] === "compaction"
    )
      this.compactions.add(text(event["event_id"]));
    if (event["type"] === "tool_result_late")
      this.late.set(text(event["event_id"]), event);
  }

  start(event: JsonObject): Turn {
    const turn = new Turn(event);
    if (event["type"] !== "woken") return turn;
    const causes = object(event["data"])["causes"];
    if (!Array.isArray(causes)) throw new Error("a validated wake has causes");
    const results = [...new Set(causes.map(text))]
      .map((id) => {
        const result = this.late.get(id);
        if (result === undefined)
          throw new Error("a verified wake has a preceding late result");
        return result;
      })
      .toSorted((a, b) => number(a["seq"]) - number(b["seq"]));
    for (const result of results) turn.record(result, this.compactions);
    return turn;
  }
}

class Turn {
  readonly opening: JsonObject;
  readonly messages: Json[] = [];
  readonly calls: Json[] = [];
  readonly results: Json[] = [];

  constructor(opening: JsonObject) {
    this.opening = opening;
  }

  record(event: JsonObject, compactions: ReadonlySet<string>): void {
    const kind = event["type"];
    const data = object(event["data"]);
    const identity = { event_id: event["event_id"], seq: event["seq"] };
    if (kind === "user_input" || kind === "steer") {
      const content = data["content"] ?? [
        { type: "text", text: data["text"] ?? "" },
      ];
      this.messages.push({ ...identity, role: "user", content });
    } else if (
      kind === "model_response" ||
      kind === "model_response_recovered"
    ) {
      if (!compactions.has(text(data["request_event_id"])))
        this.messages.push({
          ...identity,
          role: "assistant",
          content: data["content"],
          completeness: data["completeness"],
          stop_reason: data["stop_reason"],
        });
    } else if (kind === "message_received")
      this.messages.push({ ...identity, role: "mail", data });
    else if (kind === "tool_call") this.calls.push({ ...identity, data });
    else if (kind === "tool_result" || kind === "tool_result_late")
      this.results.push({ ...identity, type: kind, data });
  }

  completedLine(
    event: JsonObject,
    branch: string,
    since: number,
  ): string | undefined {
    const time = event["time"];
    if (typeof time !== "number")
      throw new Error("a validated event has a time");
    if (event["branch_id"] === branch && time >= since)
      return this.finish(event);
    return undefined;
  }

  finish(event: JsonObject): string {
    const line = canonicalize({
      format_version: 1,
      thread_id: event["thread_id"],
      branch_id: event["branch_id"],
      trigger: { type: this.opening["type"], data: this.opening["data"] },
      turn_id: this.opening["event_id"],
      started_at: this.opening["time"],
      completed_at: event["time"],
      completion: event["data"],
      messages: this.messages,
      tool_calls: this.calls,
      tool_results: this.results,
    });
    if (!line.ok)
      throw new ProjectionError(
        `trajectory is not canonicalizable: ${line.error.message}`,
      );
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

function number(value: Json | undefined): number {
  if (typeof value !== "number")
    throw new Error("a validated event has an integer sequence");
  return value;
}
