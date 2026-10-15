import assert from "node:assert/strict";
import { test } from "vitest";
import { sleep } from "../helpers/runtime.js";
import { type WorkflowProcess, WorkflowProcessHome } from "../helpers/workflow-process.js";

const REAL_SDK_DISPOSED_OWNER_ADOPTION_TIMEOUT_MS = 180_000;
const FIXTURE = "sdk-crashed-workflow-recovery-client.ts";
const OWNED_ELSEWHERE = "WORKFLOW_RUN_OWNED_ELSEWHERE";

interface Inspection {
	runId: string;
	status: string;
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
		assert.ok(Date.now() < deadline, "owner process did not exit");
		await sleep(20);
	}
}

/** One owner process launches an agent-owned run and quits it durably; a second process observes it. */
async function withQuitRun(
	body: (owner: WorkflowProcess, other: WorkflowProcess, run: { runId: string; pid: number }) => Promise<void>,
): Promise<void> {
	const home = new WorkflowProcessHome();
	let owner: WorkflowProcess | undefined;
	try {
		owner = home.client({ ATOMIC_SDK_RECOVERY_PRODUCER: "1", ATOMIC_SDK_RECOVERY_QUITTABLE: "1" }, FIXTURE);
		const run = await owner.request<{ runId: string; pid: number }>("start");
		await owner.request("quit", run.runId);
		const other = home.client({}, FIXTURE);
		const paused = await other.request<Inspection>("inspect", run.runId);
		assert.equal(paused.status, "paused");
		assert.deepEqual(paused.listed, [], "inspection must not adopt the foreign run into this session");
		await body(owner, other, run);
	} finally {
		try {
			await owner?.crash();
		} finally {
			await home.cleanup();
		}
	}
}

test.each([
	"the owner process exits after disposing its session",
	"the owner process crashes after disposing its session",
	"the owner process keeps running after disposing its session",
])(
	"another process adopts a paused agent-launched run once its owning session is disposed: %s (#3566)",
	async (scenario) => {
		await withQuitRun(async (owner, other, { runId, pid }) => {
			assert.deepEqual(
				await other.request("controls", runId),
				{ pause: OWNED_ELSEWHERE, quit: OWNED_ELSEWHERE, resume: OWNED_ELSEWHERE },
				"a run whose owning session is still live must stay refused",
			);
			if (scenario.includes("exits")) {
				await owner.request("exit");
				await owner.waitForExit();
			} else {
				await owner.request("dispose");
				if (scenario.includes("crashes")) {
					await owner.request("crash");
					await waitForProcessExit(pid);
					await owner.waitForExit();
				} else process.kill(pid, 0);
			}
			const resumed = await other.request<Inspection>("resume", runId);
			assert.equal(resumed.runId, runId, "adoption must reuse the durable identity");
			assert.equal(resumed.status, "completed");
			assert.deepEqual(resumed.listed, [runId], "the adopting SDK session must own the resumed run");
			assert.equal(resumed.effect, "effect\n", "completed author side effects must not execute again");
		});
	},
	REAL_SDK_DISPOSED_OWNER_ADOPTION_TIMEOUT_MS,
);

test(
	"another process still refuses a paused agent-launched run whose owner crashed without disposing its session (#3566)",
	async () => {
		await withQuitRun(async (owner, other, { runId, pid }) => {
			await owner.request("crash");
			await waitForProcessExit(pid);
			await owner.waitForExit();
			assert.deepEqual(await other.request("controls", runId), {
				pause: OWNED_ELSEWHERE,
				quit: OWNED_ELSEWHERE,
				resume: OWNED_ELSEWHERE,
			});
			assert.equal((await other.request<Inspection>("inspect", runId)).status, "paused");
		});
	},
	REAL_SDK_DISPOSED_OWNER_ADOPTION_TIMEOUT_MS,
);
