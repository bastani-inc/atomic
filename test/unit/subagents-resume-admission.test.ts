import assert from "node:assert/strict";
import { test } from "vitest";
import {
	liveOwnerlessAdmissions,
	runOwnerlessChild,
} from "../../packages/subagents/src/runs/foreground/ownerless-children.js";
import { collectGarbage, trackCollection } from "../helpers/collect-garbage.js";

test("resume drops admission data with the SDK launch handle (#5560)", async () => {
	const owner = "admission-owner";
	const tracked = trackCollection();
	async function launchAndFinish() {
		const finish = Promise.withResolvers<void>();
		const launch = runOwnerlessChild({
			agent: "worker",
			task: "finish",
			cwd: ".",
			options: { runId: "admission-identity" },
			recordChild: { ownerSessionId: owner, record() {} },
			runSync: async () => {
				await finish.promise;
				return {
					agent: "worker",
					task: "finish",
					status: "ok",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				};
			},
		});
		const [identity] = liveOwnerlessAdmissions(owner);
		assert.ok(identity);
		assert.equal(identity.taskId, launch.launchId);
		tracked.track(identity);
		finish.resolve();
		await launch.result;
	}
	await launchAndFinish();
	assert.deepEqual([...liveOwnerlessAdmissions(owner)], []);
	await collectGarbage();
	assert.deepEqual(tracked.uncollected(), [], "the admission lookup must not keep the retired identity reachable");
});
