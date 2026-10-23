import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";

const directory = process.env.ATOMIC_TEST_POOL_STARTUP_DIR;
const mode = process.env.ATOMIC_TEST_POOL_STARTUP_MODE;

function claimSlowWorker(path: string): boolean {
	try {
		const descriptor = openSync(path, "wx");
		writeSync(descriptor, String(process.pid));
		closeSync(descriptor);
		return true;
	} catch {
		return false;
	}
}

if (directory !== undefined && mode !== undefined) {
	if (claimSlowWorker(join(directory, "slow-worker")) || mode === "hang-all") {
		writeSync(2, "pool startup fixture stderr (#3887)\n");
		if (mode === "exit") process.exit(3);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	}
}

export const child = workflow({
	name: "pool-startup-child",
	description: "Loads slowly or fails in selected local workers",
	inputs: {},
	outputs: { pid: Type.Number() },
	async run(ctx) {
		return { pid: await ctx.tool("pid", {}, async () => process.pid) };
	},
});
