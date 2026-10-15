import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { getBrokerPidPath } from "../../packages/intercom/broker/paths.js";
import { readText } from "../helpers/runtime.js";
import { WorkflowProcessHome } from "../helpers/workflow-process.js";

test("workflow fixture cleanup waits for its detached broker to exit (#3647)", async () => {
	const home = new WorkflowProcessHome();
	const client = home.client({}, "workflow-process-broker-client.ts");
	let brokerPid: number;
	try {
		await client.request("start");
		brokerPid = Number(await readText(getBrokerPidPath(join(home.path, ".atomic", "agent"))));
		assert.ok(Number.isSafeInteger(brokerPid) && brokerPid > 0);
		process.kill(brokerPid, 0);
	} finally {
		await home.cleanup();
	}
	assert.throws(() => process.kill(brokerPid, 0), { code: "ESRCH" });
});
