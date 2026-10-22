import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { JsonObject } from "../../src/log/primitives";
import { Trajectory } from "../../src/trajectories/schema";

const Case = z.strictObject({ name: z.string(), valid: z.boolean(), record: JsonObject });
const cases = z.array(Case).parse(
  JSON.parse(
    readFileSync(
      new URL("../../../../../spec/conformance/vectors/trajectory-contracts.json", import.meta.url),
      "utf8",
    ),
  ),
);

test.each(cases)("trajectory boundary contract: $name", ({ valid, record }) => {
  expect(Trajectory.safeParse(record).success).toBe(valid);
});
