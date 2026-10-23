import { z } from "zod";
import { TextOrContent, TextOrRef } from "../src/log";
import { TrajectorySchema } from "../src/trajectories/schema";
import { type Node, tidy } from "./spec-schema";

function node(value: z.core.util.JSONType | undefined): value is Node {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Include definitions named only by event refinements, then apply the shared rules pass. */
export function trajectorySchema(): Node {
  const exported = z.toJSONSchema(
    z.tuple([TrajectorySchema, TextOrContent, TextOrRef]),
    {
      target: "draft-2020-12",
      io: "input",
      unrepresentable: "throw",
    },
  );
  const tree: z.core.util.JSONType = JSON.parse(JSON.stringify(exported));
  const defs = node(tree) ? tree["$defs"] : undefined;
  if (!node(defs)) throw new Error("trajectory export has no definitions");
  const { Trajectory: root, ...rest } = defs;
  if (!node(root)) throw new Error("trajectory export has no root");
  return tidy(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:threads:schema:trajectory:v1",
      ...root,
      $defs: rest,
    },
    rest,
  );
}
