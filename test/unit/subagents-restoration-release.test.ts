import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import {
	isLiveOwnerlessChild,
	isQueuedOwnerlessChild,
	runOwnerlessChild,
	stopOwnerlessChild,
	takeStoppedQueuedOwnerlessChild,
} from "../../packages/subagents/src/runs/foreground/ownerless-children.js";
import { createSubagentChildRecordSink } from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	restoreSubagentChild,
	type SubagentChildRestoreDeps,
	subagentRestoreRegistrySizes,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import type { SingleResult } from "../../packages/subagents/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

test("a restored subagent waiting for its run's slot stays restored while its parent stops waiting on it, so a second restore joins it", async () => {
	const dir = makeTempDirectory("restoration-release-");
	const owner = SessionManager.inMemory(dir);
	const runId = `slot-${randomUUID()}`;
	const childId = `${runId}:0`;
	// Its run's only slot is taken: nothing it launches is dispatched here, so no child runs.
	const waiting: Array<() => Promise<void>> = [];
	const schedule = Object.assign((dispatch: () => Promise<void>) => void waiting.push(dispatch), { limit: 1 });
	const agent: AgentConfig = {
		name: "worker",
		description: "",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: join(dir, "worker.md"),
	};
	const atomic = {
		events: { on: () => () => {}, emit() {} },
		appendEntry: async (customType: string, data: unknown) => void (await owner.appendCustomEntry(customType, data)),
		getSessionName: () => "owner",
	} as unknown as ExtensionAPI;
	const ctx = {
		sessionManager: owner,
		cwd: dir,
		hasUI: false,
		ui: {},
		modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
	} as unknown as ExtensionContext;
	const recordChild = createSubagentChildRecordSink(atomic, ctx);
	let runs = 0;
	const runSync = async (): Promise<SingleResult> => {
		runs++;
		throw new Error("no child runs here");
	};
	const deps = {
		pi: atomic,
		config: {},
		discoverAgents: () => ({ agents: [agent] }),
		runtime: { runSync },
	} as unknown as SubagentChildRestoreDeps;
	// Its parallel launch's parent stops waiting on its children when one of them hands off.
	const parentStopsWaiting = new AbortController();
	const launched = runOwnerlessChild({
		agent: agent.name,
		agentSource: agent.source,
		task: "the task",
		cwd: dir,
		options: { runId, index: 0, cwd: dir, sessionDir: dir, intercomDetachSignal: parentStopsWaiting.signal },
		recordChild,
		schedule,
		runSync,
	});
	const before = subagentRestoreRegistrySizes().active;
	let restoredTaskId: string | undefined;
	try {
		await recordChild.flushed?.();
		assert.equal(await stopOwnerlessChild(launched.launchId, "paused"), true);
		await launched.ended;
		await recordChild.flushed?.();
		const restored = await restoreSubagentChild(deps, ctx, childId, { prompt: "go on", message: "go on" });
		assert.equal(restored.kind, "restored");
		restoredTaskId = restored.kind === "restored" ? restored.taskId : undefined;
		assert.ok(restoredTaskId && isQueuedOwnerlessChild(restoredTaskId), "it waits for its run's slot");

		parentStopsWaiting.abort();
		await launched.result;
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(isLiveOwnerlessChild(restoredTaskId), true, "it still waits for its run's slot");
		assert.equal(subagentRestoreRegistrySizes().active, before + 1, "its restoration is not over");
		const again = await restoreSubagentChild(deps, ctx, childId);
		assert.deepEqual(
			again.kind === "restored" ? again.taskId : again.kind,
			restoredTaskId,
			"a second restore joins it rather than launching it again",
		);
		assert.equal(await stopOwnerlessChild(restoredTaskId, "paused"), true);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(subagentRestoreRegistrySizes().active, before, "stopped before it started, its restoration is over");
		assert.equal(runs, 0);
	} finally {
		for (const launchId of [launched.launchId, restoredTaskId])
			if (launchId !== undefined && isLiveOwnerlessChild(launchId)) await stopOwnerlessChild(launchId, "paused");
		for (const dispatch of waiting) await dispatch().catch(() => undefined);
		for (const launchId of [launched.launchId, restoredTaskId])
			if (launchId !== undefined) takeStoppedQueuedOwnerlessChild(launchId);
		await recordChild.flushed?.();
		removeTempDirectory(dir);
	}
});
