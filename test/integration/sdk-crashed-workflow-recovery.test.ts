import assert from "node:assert/strict";
import { test } from "vitest";
import { type RealPostgresClient, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";
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

test.each(["local process", "copied VM identity"])(
	"fresh in-memory SDK hosts exclude live owners and recover crashed runs with %s without replaying completed effects (#3419)",
	async (locality) => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		let producer: RealPostgresClient | undefined;
		try {
			producer = home.client(
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
			if (locality === "copied VM identity") await recoverer.request("mask-owner", String(pid));
			await recoverer.request("expire");
			const expiredControls = await recoverer.request("controls", runId);
			process.kill(pid, 0);
			const expiredLive = await recoverer.request<Inspection>("inspect", runId);
			await producer.request("crash");
			await waitForProcessExit(pid);
			await producer.waitForExit();
			assert.deepEqual(
				expiredControls,
				{
					pause: ownedElsewhere,
					quit: ownedElsewhere,
					resume: ownedElsewhere,
				},
				"an expired progress timestamp must not authorize adoption of a live producer in ctx.tool",
			);
			assert.equal(expiredLive.status, "running", "a verified live producer must not be shown as crashed");
			assert.deepEqual(expiredLive.listed, []);
			assert.equal(expiredLive.effect, "effect\n");
			await recoverer.request("expire");
			const crashed = await recoverer.request<Inspection>("inspect", runId);
			assert.equal(crashed.status, "crashed");
			assert.deepEqual(crashed.listed, []);
			assert.equal(crashed.effect, "effect\n");
			const competitor = home.client(listener.port, {}, "sdk-crashed-workflow-recovery-client.ts");
			await competitor.request("expire");
			assert.equal((await competitor.request<Inspection>("inspect", runId)).status, "crashed");
			const attempts = await Promise.allSettled([
				recoverer.request<Inspection>("resume", runId),
				competitor.request<Inspection>("resume", runId),
			]);
			const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
			const losers = attempts.filter((attempt) => attempt.status === "rejected");
			assert.equal(winners.length, 1, "only one actual SDK process may adopt the durable generation");
			assert.equal(losers.length, 1);
			assert.match(
				String(losers[0].reason),
				/belongs to another caller\/session|changed while resume was pending|actively running in another Atomic session|is completed, not resumable/,
			);
			const resumed = winners[0].value;
			assert.equal(resumed.runId, runId, "recovery must reuse the durable identity");
			assert.equal(resumed.status, "completed");
			assert.deepEqual(resumed.listed, [runId], "the adopting SDK session must own the resumed run");
			assert.equal(resumed.effect, "effect\n", "completed author side effects must not execute again");
		} finally {
			try {
				try {
					await producer?.crash();
				} finally {
					await home.cleanup();
				}
			} finally {
				await listener.close();
			}
		}
	},
	REAL_SDK_CRASHED_RECOVERY_TIMEOUT_MS,
);

test(
	"database connection loss permits recovery but fences the still-live owner's late checkpoints and metadata (#3419)",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		let producer: RealPostgresClient | undefined;
		try {
			producer = home.client(
				listener.port,
				{ ATOMIC_SDK_RECOVERY_PRODUCER: "1", ATOMIC_SDK_RECOVERY_RELEASEABLE: "1" },
				"sdk-crashed-workflow-recovery-client.ts",
			);
			const { runId, pid } = await producer.request<{ runId: string; pid: number }>("start");
			const recoverer = home.client(listener.port, {}, "sdk-crashed-workflow-recovery-client.ts");
			await recoverer.request("expire");
			assert.deepEqual(await recoverer.request("controls", runId), {
				pause: "WORKFLOW_RUN_OWNED_ELSEWHERE",
				quit: "WORKFLOW_RUN_OWNED_ELSEWHERE",
				resume: "WORKFLOW_RUN_OWNED_ELSEWHERE",
			});
			await recoverer.request("terminate-owner", runId);
			const crashed = await recoverer.request<Inspection>("inspect", runId);
			assert.equal(crashed.status, "crashed");
			process.kill(pid, 0);
			const resumed = await recoverer.request<Inspection>("resume", runId);
			assert.equal(resumed.status, "completed");
			assert.equal(resumed.effect, "effect\n");
			process.kill(pid, 0);
			const observer = home.client(listener.port, {}, "sdk-crashed-workflow-recovery-client.ts");
			const beforeLateCallback = await observer.request<{ status: string; checkpoints: object[] }>(
				"durable-state",
				runId,
			);
			assert.equal(beforeLateCallback.status, "completed");
			assert.ok(JSON.stringify(beforeLateCallback.checkpoints).includes('"finished"'));
			const sourceOutcome = await producer.request<{ status: string; resumable: boolean; error?: string }>(
				"release-source",
				runId,
			);
			assert.equal(
				sourceOutcome.status,
				"paused",
				"the disconnected source must retain its local resumable progress without completing",
			);
			assert.equal(sourceOutcome.resumable, true);
			assert.match(
				sourceOutcome.error ?? "",
				/ownership (?:connection was lost|generation changed)|stale (?:executor|execution) writes are refused/,
			);
			const afterLateCallback = await observer.request("durable-state", runId);
			assert.deepEqual(
				afterLateCallback,
				beforeLateCallback,
				"the disconnected owner's callback must not change durable checkpoints or metadata",
			);
			await producer.crash();
		} finally {
			try {
				try {
					await producer?.crash();
				} finally {
					await home.cleanup();
				}
			} finally {
				await listener.close();
			}
		}
	},
	REAL_SDK_CRASHED_RECOVERY_TIMEOUT_MS,
);
