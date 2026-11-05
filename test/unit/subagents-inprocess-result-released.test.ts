import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { subagentReleasePolicy } from "../../packages/subagents/src/runs/foreground/released-children.ts";
import { subagentRegistrySizes } from "../../packages/subagents/src/runs/foreground/subagent-registry-sizes.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { agent } from "../helpers/released-task-launch.js";

const CHILD_LOAD_TIMEOUT_MS = 120_000;
const POLL_LIMIT = 2_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

test("with nothing launched, every registry of the subagents extension is empty (#4326)", () => {
	assert.deepEqual(subagentRegistrySizes(), {
		records: 0,
		taskIds: 0,
		transcripts: 0,
		cardOwners: 0,
		appendChains: 0,
		stopRequests: 0,
		activeRestorations: 0,
		goneChildren: 0,
		queuedChildren: 0,
		schedules: 0,
		closingChildren: 0,
		earlyHolds: 0,
		ownerlessLive: 0,
		ownerlessStoppedQueued: 0,
		runWorktrees: 0,
		retainedTaskOutputs: 0,
		controls: 0,
	});
});

test(
	"only a child released while it waits carries a released field in its result (#4326)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const store = new MemorySessionStore();
		env.faux.setResponses([
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "ci-1", name: "wait_for_ci", arguments: { run: "1" } }],
				stopReason: "toolUse",
			} as never,
		]);
		const released = await runSingleInProcess(env.root, agent, "watch CI", {
			...env.options("released-field-a", {
				sessionManager: await SessionManager.create(store, env.root),
				resumeSession: true,
				releaseWhenWaiting: subagentReleasePolicy(0),
			}),
		});
		assert.equal(released.status, "interrupted");
		assert.deepEqual(
			released.released?.waitingOn.map((call) => call.toolCallId),
			["ci-1"],
		);

		env.faux.setResponses([
			{ role: "assistant", content: [{ type: "text", text: "all done" }], stopReason: "stop" } as never,
		]);
		const completed = await runSingleInProcess(env.root, agent, "say done", {
			...env.options("released-field-b"),
		});
		assert.equal(completed.status, "ok");
		assert.equal("released" in completed, false);

		const controller = new AbortController();
		env.faux.setResponses([
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "b-1", name: "block", arguments: {} }],
				stopReason: "toolUse",
			} as never,
		]);
		const running = runSingleInProcess(env.root, agent, "block", {
			...env.options("released-field-c", { signal: controller.signal }),
		});
		for (let turn = 0; turn < POLL_LIMIT && !env.blockStarted(); turn++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(env.blockStarted(), true);
		controller.abort();
		const cancelled = await running;
		assert.equal(cancelled.status, "interrupted");
		assert.equal("released" in cancelled, false);
	},
	CHILD_LOAD_TIMEOUT_MS,
);
