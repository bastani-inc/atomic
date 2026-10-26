/**
 * Local-worker pool load gate (#3903, #3996): 150 busy local workers with no stage watched,
 * then with one pooled stage watched for the whole traffic window. The two gates run one
 * after the other in this file, because two 150-worker pools at once measure each other.
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
import { runPoolLoadGate } from "../helpers/pool-load-gate.js";

/** Structural: an Intercom broker, 150 worker processes, then sustained windows and completion. */
const LOAD_GATE_TIMEOUT_MS = 900_000;

test.skipIf(process.platform === "win32")(
	"the root main thread stays responsive and heartbeats stay bounded under 150 busy local workers (#3903)",
	async () => {
		await runPoolLoadGate(0);
	},
	LOAD_GATE_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"the root main thread stays responsive under 150 busy local workers while one pooled stage is watched (#3996)",
	async () => {
		await runPoolLoadGate(1);
	},
	LOAD_GATE_TIMEOUT_MS,
);
