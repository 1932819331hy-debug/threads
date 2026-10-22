// bun examples/export-trajectories.ts STORE [SINCE_MS]
// Reads only local stored logs; makes no model or tool calls.
import { exportTrajectories, sqlite } from "threadsai";

const [path, since] = process.argv.slice(2);
if (path === undefined) throw new Error("usage: export-trajectories.ts STORE [SINCE_MS]");
const result = await exportTrajectories(sqlite(path), {
  ...(since === undefined ? {} : { since: Number(since) }),
});
if (!result.ok) {
  console.error(`${result.error.code}: ${result.error.message}`);
  process.exitCode = 1;
} else process.stdout.write(result.value);
