import assert from "node:assert/strict";
import { test } from "vitest";
import { WorkflowProcessHome } from "../helpers/workflow-process.js";

const REAL_SDK_CRASHED_RECOVERY_TIMEOUT_MS = 180_000;
const FIXTURE = "sdk-crashed-workflow-recovery-client.ts";
interface Inspection {
	runId: string;
	status: string;
	stages: number;
	listed: string[];
	effect: string;
}

test(
	"fresh SDK hosts refuse a live lease and recover a crashed run exactly once (#3419)",
	async () => {
		const home = new WorkflowProcessHome();
		try {
			const producer = home.client({ ATOMIC_SDK_RECOVERY_PRODUCER: "1" }, FIXTURE);
			const { runId } = await producer.request<{ runId: string }>("start");
			const recoverer = home.client({}, FIXTURE);
			const live = await recoverer.request<Inspection>("inspect", runId);
			assert.equal(live.status, "running");
			assert.deepEqual(live.listed, []);
			assert.equal(live.effect, "effect\n");
			const ownedElsewhere = "WORKFLOW_RUN_OWNED_ELSEWHERE";
			assert.deepEqual(await recoverer.request("controls", runId), {
				pause: ownedElsewhere,
				quit: ownedElsewhere,
				resume: ownedElsewhere,
			});
			await producer.crash();
			await recoverer.request("expire");
			assert.equal((await recoverer.request<Inspection>("inspect", runId)).status, "crashed");
			const competitor = home.client({}, FIXTURE);
			await competitor.request("expire");
			const attempts = await Promise.allSettled([
				recoverer.request<Inspection>("resume", runId),
				competitor.request<Inspection>("resume", runId),
			]);
			const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
			const losers = attempts.filter((attempt) => attempt.status === "rejected");
			assert.equal(winners.length, 1);
			assert.equal(losers.length, 1);
			const resumed = winners[0]!.value;
			assert.equal(resumed.runId, runId);
			assert.equal(resumed.status, "completed");
			assert.deepEqual(resumed.listed, [runId]);
			assert.equal(resumed.effect, "effect\n");
		} finally {
			await home.cleanup();
		}
	},
	REAL_SDK_CRASHED_RECOVERY_TIMEOUT_MS,
);
