import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createWorkflowPendingStageDelivery } from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";

const ROOT_RUN_ID = "3760aaaa-1111-4111-8111-111111111111";
const GROUP = `workflow:${ROOT_RUN_ID}`;
const SENDER = { id: "parent-before-restart", name: "parent", group: GROUP, cwd: "/repo" };

afterEach(() => setDurableBackend(undefined));

interface RouteAnnouncement {
	readonly runId: string;
	readonly group: string;
	readonly stages?: ReadonlyArray<{ readonly stageName: string; readonly target: string; readonly group: string }>;
}

function announcedRoutes(store: Store): { routes: RouteAnnouncement[]; dispose: () => void } {
	const routes: RouteAnnouncement[] = [];
	const dispose = registerPendingStageIntercomBridge(
		{
			events: {
				emit(event: string, payload: Record<string, unknown>) {
					if (event !== "atomic:workflow-pending-stage-route") return;
					routes.push(payload as unknown as RouteAnnouncement);
					payload.completion = Promise.resolve();
				},
				on: () => () => {},
			},
		},
		store,
	);
	return { routes, dispose };
}

function laneTarget(routes: readonly RouteAnnouncement[]) {
	return routes
		.filter((route) => route.runId === ROOT_RUN_ID)
		.flatMap((route) => route.stages ?? [])
		.find((stage) => stage.stageName === "lane");
}

test("a resumed workflow run keeps its stage addresses and delivers messages queued while it was down exactly once (#3760)", async () => {
	const writer = await JournalTestBackend.create();
	let stageStarted = Promise.withResolvers<void>();
	let releaseStage = Promise.withResolvers<void>();
	const flow = workflow({
		name: "resume-addressing",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const lane = ctx.stage("lane");
			stageStarted.resolve();
			await releaseStage.promise;
			return { value: await lane.complete("task") };
		},
	});
	const adapters = { complete: { complete: async (text: string) => text } };

	const firstStore = createStore();
	const first = announcedRoutes(firstStore);
	const firstController = new AbortController();
	const firstRun = run(
		flow,
		{},
		{ runId: ROOT_RUN_ID, store: firstStore, durableBackend: writer, signal: firstController.signal, adapters },
	);
	await stageStarted.promise;
	const before = laneTarget(first.routes);
	assert.ok(before);
	assert.equal(before.group, GROUP);
	await firstStore.queueStageMessage(
		{
			runId: ROOT_RUN_ID,
			stageKey: "lane",
			from: SENDER,
			message: { id: "queued-while-down", timestamp: 1, content: { text: "exact path" } },
			queuedAt: "2026-10-19T07:00:00.000Z",
		},
		GROUP,
		GROUP,
		writer,
	);
	await firstStore.queueStickyStageMessage(
		{
			runId: ROOT_RUN_ID,
			stageKey: `${GROUP}/**`,
			targetPath: `${GROUP}/**`,
			from: SENDER,
			message: { id: "sticky-while-down", timestamp: 2, content: { text: "every stage" } },
			queuedAt: "2026-10-19T07:00:01.000Z",
		},
		GROUP,
		GROUP,
		writer,
	);
	first.dispose();
	const crashedStage = releaseStage;

	stageStarted = Promise.withResolvers<void>();
	releaseStage = Promise.withResolvers<void>();
	const reader = await writer.reopen();
	await reader.hydrateWorkflow(ROOT_RUN_ID);
	setDurableBackend(reader);
	const resumedStore = createStore();
	const resumed = announcedRoutes(resumedStore);
	const resumedRun = run(flow, {}, { runId: ROOT_RUN_ID, store: resumedStore, durableBackend: reader, adapters });
	await stageStarted.promise;

	const after = laneTarget(resumed.routes);
	assert.deepEqual(after, before);
	const root = resumedStore.runs().find((candidate) => candidate.id === ROOT_RUN_ID);
	const stage = root?.stages.find((candidate) => candidate.name === "lane");
	assert.ok(stage);
	assert.equal(stage.intercomGroup ?? GROUP, GROUP);

	const delivered: string[] = [];
	const delivery = createWorkflowPendingStageDelivery(resumedStore, ROOT_RUN_ID, stage.id, stage.name);
	await delivery.deliverPending(
		async (_from, message) => {
			delivered.push(message.id);
		},
		{ sessionId: "resumed-lane-session", receivedMessageIds: [] },
	);
	await delivery.deliverPending(
		async (_from, message) => {
			delivered.push(message.id);
		},
		{ sessionId: "resumed-lane-session", receivedMessageIds: delivered },
	);
	assert.deepEqual([...delivered].sort(), ["queued-while-down", "sticky-while-down"]);

	releaseStage.resolve();
	assert.equal((await resumedRun).status, "completed");
	resumed.dispose();
	firstController.abort(new Error("crashed process reaped"));
	crashedStage.resolve();
	await assert.rejects(firstRun, /Journal backend is closed/);
});
