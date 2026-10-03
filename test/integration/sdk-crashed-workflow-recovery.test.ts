import assert from "node:assert/strict";
import { test } from "vitest";
import { RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";
import { sleep } from "../helpers/runtime.js";

const REAL_SDK_CRASHED_RECOVERY_TIMEOUT_MS = 180_000;
interface Inspection {
	runId: string;
	status: string;
	stages: number;
	listed: string[];
	effect: string;
}

async function waitForProcessExit(pid: number): Promise<void> {
	const deadline = Date.now() + 5000;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
			return;
		}
		assert.ok(Date.now() < deadline, "producer did not die after its crash acknowledgement");
		await sleep(20);
	}
}

test(
	"fresh in-memory SDK hosts inspect and adopt a crashed earlier-process durable run without replaying side effects (#3419)",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		try {
			const producer = home.client(
				listener.port,
				{ ATOMIC_SDK_RECOVERY_PRODUCER: "1" },
				"sdk-crashed-workflow-recovery-client.ts",
			);
			const { runId, pid } = await producer.request<{ runId: string; pid: number }>("start");
			const recoverer = home.client(listener.port, {}, "sdk-crashed-workflow-recovery-client.ts");
			const live = await recoverer.request<Inspection>("inspect", runId);
			assert.equal(live.runId, runId);
			assert.equal(live.status, "running");
			assert.deepEqual(live.listed, [], "inspection must not adopt the foreign run into this session");
			assert.equal(live.effect, "effect\n");
			const ownedElsewhere = "WORKFLOW_RUN_OWNED_ELSEWHERE";
			assert.deepEqual(await recoverer.request("controls", runId), {
				pause: ownedElsewhere,
				quit: ownedElsewhere,
				resume: ownedElsewhere,
			});
			await producer.request("crash");
			await waitForProcessExit(pid);
			await producer.exit();
			await recoverer.request("expire");
			const crashed = await recoverer.request<Inspection>("inspect", runId);
			assert.equal(crashed.status, "crashed");
			assert.deepEqual(crashed.listed, []);
			assert.equal(crashed.effect, "effect\n");
			const resumed = await recoverer.request<Inspection>("resume", runId);
			assert.equal(resumed.runId, runId, "recovery must reuse the durable identity");
			assert.equal(resumed.status, "completed");
			assert.deepEqual(resumed.listed, [runId], "the adopting SDK session must own the resumed run");
			assert.equal(resumed.effect, "effect\n", "completed author side effects must not execute again");
		} finally {
			try {
				await home.cleanup();
			} finally {
				await listener.close();
			}
		}
	},
	REAL_SDK_CRASHED_RECOVERY_TIMEOUT_MS,
);
