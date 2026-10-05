import assert from "node:assert/strict";
import { test } from "vitest";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

test("re-announces live stage-name and stage-ID routes on session_start after reload (#3425)", () => {
	const runId = "4ac72924-c452-4e5f-9e63-2435722109f7";
	const stageId = "reviewer-id";
	const stageName = "reviewer";
	const idTarget = `workflow:${runId}/${stageId}`;
	const nameTarget = `workflow:${runId}/${stageName}`;
	const store = createStore();
	store.recordRunStart({
		id: runId,
		name: "flow",
		inputs: {},
		status: "running",
		startedAt: 1,
		stages: [
			{
				id: stageId,
				name: stageName,
				status: "running",
				parentIds: [],
				toolEvents: [],
				sessionId: "reviewer-session",
				pendingStageDeliveryAvailable: true,
			},
		],
	});
	const aliases = new Map<string, string>();
	let announcements = 0;
	let sessionStart: (() => void) | undefined;
	const dispose = registerPendingStageIntercomBridge(
		{
			on(event, listener) {
				if (event === "session_start") sessionStart = listener as () => void;
			},
			events: {
				emit(event, payload) {
					if (event !== "atomic:workflow-pending-stage-route") return;
					announcements++;
					const stages = payload.stages as {
						stageId: string;
						stageName: string;
						target: string;
						lifecycle: string;
						routeEligible: boolean;
					}[];
					for (const stage of stages) {
						assert.equal(stage.lifecycle, "running");
						assert.equal(stage.routeEligible, true);
						aliases.set(`workflow:${payload.runId}/${stage.stageId}`, stage.target);
						aliases.set(`workflow:${payload.runId}/${stage.stageName}`, stage.target);
					}
					payload.completion = Promise.resolve();
				},
			},
		},
		store,
	);
	try {
		assert.equal(announcements, 1);
		assert.equal(aliases.get(nameTarget), idTarget);
		assert.equal(aliases.get(idTarget), idTarget);
		store.recordStageAttached(runId, stageId, true);
		assert.equal(announcements, 1);
		aliases.clear();
		assert.equal(aliases.get(nameTarget), undefined);
		assert.equal(aliases.get(idTarget), undefined);
		assert.ok(sessionStart);
		sessionStart();
		assert.equal(announcements, 2);
		assert.equal(aliases.get(nameTarget), idTarget);
		assert.equal(aliases.get(idTarget), idTarget);
	} finally {
		dispose();
	}
});
