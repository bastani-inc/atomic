/**
 * Local-worker pool load gate (#3903): 150 busy local workers, no stage watched.
 * The gate itself, its bounds and what it measures are in test/helpers/pool-load-gate.ts.
 *
 * Run alone:
 *
 *   npx vitest --run --project integration test/integration/workflow-pool-load-gate.test.ts
 *
 * The measured numbers are printed on every run, pass or fail. Under an agent
 * shell, add `--reporter=default`: vitest's agent reporter hides passing output.
 */
import { test } from "vitest";
import { POOL_LOAD_GATE_TIMEOUT_MS, runPoolLoadGate } from "../helpers/pool-load-gate.js";

test.skipIf(process.platform === "win32")(
	"the root main thread stays responsive and heartbeats stay bounded under 150 busy local workers (#3903)",
	() => runPoolLoadGate(0),
	POOL_LOAD_GATE_TIMEOUT_MS,
);
