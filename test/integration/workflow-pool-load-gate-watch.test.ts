/**
 * Local-worker pool load gate with one watched stage (#3996): 150 busy local workers while
 * the root holds a live view of one pooled stage that streams for the whole traffic window.
 * The gate itself, its bounds and what it measures are in test/helpers/pool-load-gate.ts.
 *
 * Run alone:
 *
 *   npx vitest --run --project integration test/integration/workflow-pool-load-gate-watch.test.ts
 *
 * The measured numbers are printed on every run, pass or fail. Under an agent
 * shell, add `--reporter=default`: vitest's agent reporter hides passing output.
 */
import { test } from "vitest";
import { POOL_LOAD_GATE_TIMEOUT_MS, runPoolLoadGate } from "../helpers/pool-load-gate.js";

test.skipIf(process.platform === "win32")(
	"the root main thread stays responsive under 150 busy local workers while one pooled stage is watched (#3996)",
	() => runPoolLoadGate(1),
	POOL_LOAD_GATE_TIMEOUT_MS,
);
