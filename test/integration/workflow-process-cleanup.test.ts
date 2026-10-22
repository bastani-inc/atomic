import assert from "node:assert/strict";
import { join } from "node:path";
import { test, vi } from "vitest";
import { getBrokerPidPath } from "../../packages/intercom/broker/paths.js";
import { readText } from "../helpers/runtime.js";
import { WorkflowProcessHome } from "../helpers/workflow-process.js";

/** The socket can accept before the broker's listen callback publishes its PID. */
const BROKER_PID_READY_TIMEOUT_MS = 10_000;

test("workflow fixture cleanup waits for its detached broker to exit (#3647)", async () => {
	const home = new WorkflowProcessHome();
	const client = home.client({}, "workflow-process-broker-client.ts");
	let brokerPid: number;
	try {
		await client.request("start");
		brokerPid = await vi.waitFor(
			async () => {
				const pid = Number(await readText(getBrokerPidPath(join(home.path, ".atomic", "agent"))));
				assert.ok(Number.isSafeInteger(pid) && pid > 0);
				return pid;
			},
			{ timeout: BROKER_PID_READY_TIMEOUT_MS, interval: 20 },
		);
		assert.ok(Number.isSafeInteger(brokerPid) && brokerPid > 0);
		process.kill(brokerPid, 0);
	} finally {
		await home.cleanup();
	}
	assert.throws(() => process.kill(brokerPid, 0), { code: "ESRCH" });
});
