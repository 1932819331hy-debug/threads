import { z } from "zod";
import { InputPart } from "../log/content";
import { TurnCompletedData } from "../log/events/control";
import { ToolResultData, ToolResultLateData } from "../log/events/effects";
import { ModelResponseData } from "../log/events/model";
import { ToolCallData } from "../log/events/tools";
import { BranchId, EventId, ThreadId } from "../log/ids";
import { PosInt, TimeMs } from "../log/primitives";
import type { Arr, Opt, Strict } from "../log/zod-types";

type Identity = { event_id: typeof EventId; seq: typeof PosInt };
const identity: Identity = { event_id: EventId, seq: PosInt };
const User: Strict<Identity & { role: z.ZodLiteral<"user">; content: Arr<typeof InputPart> }> =
  z.strictObject({ ...identity, role: z.literal("user"), content: z.array(InputPart) });
const Assistant: Strict<Identity & {
  role: z.ZodLiteral<"assistant">;
  content: typeof ModelResponseData.shape.content;
  completeness: typeof ModelResponseData.shape.completeness;
  stop_reason: typeof ModelResponseData.shape.stop_reason;
}> = z.strictObject({ ...identity, role: z.literal("assistant"),
  ...ModelResponseData.pick({ content: true, completeness: true, stop_reason: true }).shape });
const Message: z.ZodDiscriminatedUnion<readonly [typeof User, typeof Assistant], "role"> =
  z.discriminatedUnion("role", [User, Assistant]);
const Call: Strict<Identity & { data: typeof ToolCallData }> = z.strictObject({ ...identity, data: ToolCallData });
const Result: Strict<Identity & { type: z.ZodLiteral<"tool_result">; data: typeof ToolResultData }> =
  z.strictObject({ ...identity, type: z.literal("tool_result"), data: ToolResultData });
const LateResult: Strict<Identity & { type: z.ZodLiteral<"tool_result_late">; data: typeof ToolResultLateData }> =
  z.strictObject({ ...identity, type: z.literal("tool_result_late"), data: ToolResultLateData });
const ToolResult: z.ZodDiscriminatedUnion<readonly [typeof Result, typeof LateResult], "type"> =
  z.discriminatedUnion("type", [Result, LateResult]);

export const Trajectory: Strict<{
  format_version: z.ZodLiteral<1>; thread_id: typeof ThreadId; branch_id: typeof BranchId;
  turn_id: typeof EventId; started_at: typeof TimeMs; completed_at: typeof TimeMs;
  completion: typeof TurnCompletedData; messages: Arr<typeof Message>;
  tool_calls: Arr<typeof Call>; tool_results: Arr<typeof ToolResult>;
}> = z.strictObject({
  format_version: z.literal(1), thread_id: ThreadId, branch_id: BranchId,
  turn_id: EventId, started_at: TimeMs, completed_at: TimeMs, completion: TurnCompletedData,
  messages: z.array(Message), tool_calls: z.array(Call), tool_results: z.array(ToolResult),
}).meta({ id: "Trajectory" });
export type Trajectory = z.infer<typeof Trajectory>;

export const TrajectoryOptions: Strict<{
  threads: Opt<Arr<typeof ThreadId>>; since: Opt<typeof TimeMs>;
}> = z.strictObject({ threads: z.array(ThreadId).optional(), since: TimeMs.optional() })
  .meta({ id: "TrajectoryOptions" });
export type TrajectoryOptions = {
  readonly [K in keyof z.input<typeof TrajectoryOptions>]: Readonly<z.input<typeof TrajectoryOptions>[K]>;
};

/** The selected store rows are untrusted too. */
export const TrajectoryBranch: Strict<{
  branch_id: typeof BranchId; thread_id: typeof ThreadId;
  head_verified: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>]>;
}> = z.strictObject({ branch_id: BranchId, thread_id: ThreadId,
  head_verified: z.union([z.literal(0), z.literal(1)]),
}).meta({ id: "TrajectoryBranch" });

/** All roots needed by the generated Python models. */
export const TrajectorySchema: z.ZodTuple<readonly [typeof Trajectory, typeof TrajectoryOptions, typeof TrajectoryBranch]> =
  z.tuple([Trajectory, TrajectoryOptions, TrajectoryBranch]);
