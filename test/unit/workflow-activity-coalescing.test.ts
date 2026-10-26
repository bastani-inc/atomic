import assert from "node:assert/strict";
import { test } from "vitest";
import { WorkflowActivityHub } from "../../packages/coding-agent/src/core/extensions/workflow-activity-hub.js";
import type { WorkflowRootActivity } from "../../packages/coding-agent/src/core/extensions/workflow-events.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createWorkflowObservation } from "../../packages/workflows/src/extension/workflow-observation.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

function readyRoots(hub: WorkflowActivityHub): readonly WorkflowRootActivity[] {
	const frame = hub.getSnapshotFrame();
	assert.ok(frame.availability === "ready");
	return frame.roots;
}

test("a waiter resolved by a root run's lifecycle event reads root activity consistent with it (#4009)", async () => {
	const store = createStore();
	const hub = new WorkflowActivityHub();
	const seen: { status: string; activity: WorkflowRootActivity | undefined; published: WorkflowRootActivity[] }[] = [];
	const changed: WorkflowRootActivity[] = [];
	hub.bindDispatcher(async (event) => {
		if (event.type === "workflow_activity_changed") changed.push(event.root);
		if (event.type !== "workflow_lifecycle" || event.target.kind !== "run" || event.runId !== event.rootRunId) return;
		seen.push({
			status: event.target.status,
			activity: readyRoots(hub).find((root) => root.rootRunId === event.rootRunId),
			published: [...changed],
		});
	});
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
	try {
		await run(
			workflow({
				name: "settles",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.tool("step", {}, async () => "done");
					return {};
				},
			}),
			{},
			{ store, durableBackend: await createMemoryTestBackend() },
		);
		await new Promise((resolve) => setImmediate(resolve));
		const completed = seen.find((entry) => entry.status === "completed");
		assert.ok(completed, `no completed root lifecycle among ${JSON.stringify(seen.map((entry) => entry.status))}`);
		assert.equal(completed.activity?.endedStatus, "completed");
		assert.equal(completed.activity?.state, "idle");
		// Observers that act on the lifecycle event already received the settled activity.
		assert.equal(completed.published.at(-1)?.endedStatus, "completed");
	} finally {
		observation.dispose();
	}
});

test("a read of the hub inside a burst of store changes sees the burst's latest root activity (#4009)", async () => {
	const store = createStore();
	const hub = new WorkflowActivityHub();
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const result = run(
		workflow({
			name: "holds",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("hold", {}, async () => {
					entered.resolve();
					await release.promise;
					return "done";
				});
				return {};
			},
		}),
		{},
		{ store, durableBackend: await createMemoryTestBackend() },
	);
	try {
		await entered.promise;
		// Same turn of the event loop as the tool's admission: nothing has flushed on its own yet.
		assert.equal(readyRoots(hub)[0]?.state, "working");
		assert.equal(readyRoots(hub)[0]?.activeExecutionCount, 1);
	} finally {
		release.resolve();
		await result;
		observation.dispose();
	}
});

for (const pendingCase of ["changed", "removed"] as const) {
	test(`an observer that subscribes while ${pendingCase} publications are pending receives its snapshot first (#4009)`, async () => {
		const store = createStore();
		const hub = new WorkflowActivityHub();
		const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
		const root = (id: string) => ({
			id,
			name: id,
			inputs: {},
			status: "running" as const,
			stages: [],
			toolNodes: [],
			startedAt: 1,
		});
		try {
			store.recordRunStart(root("kept"));
			store.recordRunStart(root("gone"));
			await new Promise((resolve) => setImmediate(resolve));
			// Pending inside this turn: a changed root, or a removed one.
			if (pendingCase === "changed") store.recordRunEnd("kept", "completed");
			else store.removeRun("gone");
			const frames: { kind: string; roots: Map<string, WorkflowRootActivity> }[] = [];
			const folded = new Map<string, WorkflowRootActivity>();
			let firstKind: string | undefined;
			const subscription = hub.observeWorkflowActivity((frame) => {
				firstKind ??= frame.kind;
				if (frame.kind === "snapshot") {
					folded.clear();
					if (frame.availability === "ready") for (const entry of frame.roots) folded.set(entry.rootRunId, entry);
				} else if (frame.kind === "changed") {
					assert.ok(folded.has(frame.root.rootRunId), "a change applies to a root the observer knows");
					folded.set(frame.root.rootRunId, frame.root);
				} else {
					assert.ok(folded.delete(frame.rootRunId), "a removal applies to a root the observer knows");
				}
				frames.push({ kind: frame.kind, roots: new Map(folded) });
			});
			await new Promise((resolve) => setImmediate(resolve));
			subscription.dispose();
			assert.equal(firstKind, "snapshot");
			const last = frames.at(-1)!.roots;
			if (pendingCase === "changed") assert.equal(last.get("kept")?.endedStatus, "completed");
			else assert.deepEqual([...last.keys()], ["kept"]);
			assert.deepEqual(
				[...last.values()],
				readyRoots(hub).map((entry) => entry),
				"the observer's fold matches the hub",
			);
		} finally {
			observation.dispose();
		}
	});
}
