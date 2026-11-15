import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import {
	type InFlightRun,
	normalizeSessionEntries,
	restoreOnSessionStart,
	type SessionEntry,
	scanInFlightRuns,
} from "../../packages/workflows/src/shared/persistence-restore.js";
import { restoreTerminalRuns } from "../../packages/workflows/src/shared/persistence-restore-helpers.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

afterEach(() => {
	setDurableBackend(undefined);
});

function resumedInPlaceEntries(): SessionEntry[] {
	return [
		{ id: "e1", type: "workflow.run.start", payload: { runId: "X", name: "wf", inputs: {}, ts: 1 } },
		{ id: "e2", type: "workflow.stage.start", payload: { runId: "X", stageId: "a", name: "a", ts: 2 } },
		{
			id: "e3",
			type: "workflow.run.end",
			payload: { runId: "X", status: "failed", error: "first attempt failed", endedAt: 3, ts: 3 },
		},
		{
			id: "e4",
			type: "workflow.run.start",
			payload: { runId: "X", name: "wf", inputs: {}, resumedFromRunId: "X", ts: 4 },
		},
		{ id: "e5", type: "workflow.stage.start", payload: { runId: "X", stageId: "b", name: "b", ts: 5 } },
	];
}

test("reports a failed run resumed in place as in flight after its earlier end (#4858)", () => {
	const inFlight = scanInFlightRuns(resumedInPlaceEntries());

	assert.deepEqual(
		inFlight.map((run) => ({ runId: run.runId, startTs: run.startTs, stageIds: run.stageIds })),
		[{ runId: "X", startTs: 4, stageIds: ["b"] }],
	);
});

test("restores a resumed run as terminal only from the end that follows its latest start (#4858)", () => {
	const inFlightStore = createStore();
	restoreTerminalRuns(normalizeSessionEntries(resumedInPlaceEntries()), inFlightStore);
	assert.equal(inFlightStore.run("X"), undefined);

	const entries: SessionEntry[] = [
		...resumedInPlaceEntries(),
		{
			id: "e6",
			type: "workflow.run.end",
			payload: { runId: "X", status: "failed", error: "second attempt failed", endedAt: 6, ts: 6 },
		},
	];
	assert.deepEqual(scanInFlightRuns(entries), []);
	const endedStore = createStore();
	restoreTerminalRuns(normalizeSessionEntries(entries), endedStore);
	const restored = endedStore.run("X");
	assert.equal(restored?.status, "failed");
	assert.equal(restored?.endedAt, 6);
	assert.equal(restored?.error, "second attempt failed");
});

test("does not restore a resumed in-flight run with its earlier failure (#4858)", () => {
	const store = createStore();
	const crashed: InFlightRun[] = [];

	restoreOnSessionStart(
		{ getEntries: () => resumedInPlaceEntries() },
		{ resumeInFlight: "never", persistRuns: true },
		store,
		{ onCrashed: (run) => crashed.push(run) },
	);

	assert.deepEqual(
		crashed.map((run) => run.runId),
		["X"],
	);
	const restored = store.run("X");
	assert.equal(restored?.status, "failed");
	assert.match(restored?.error ?? "", /process was interrupted/);
	assert.doesNotMatch(restored?.error ?? "", /first attempt failed/);
});

async function crashDuringResumedAttempt(): Promise<{ runId: string; entries: SessionEntry[] }> {
	setDurableBackend(await createMemoryTestBackend());
	const entries: SessionEntry[] = [];
	let attempts = 0;
	const resumedStageStarted = Promise.withResolvers<void>();
	const definition = workflow({
		name: "resumed-then-crashed",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("flaky").prompt("work");
			return {};
		},
	});
	const jobs = createJobTracker();
	const runtime = createExtensionRuntime({
		definitions: [definition],
		store: createStore(),
		jobs,
		persistence: {
			appendEntry(type, payload) {
				const id = `entry-${entries.length + 1}`;
				entries.push({ id, type, payload: payload as SessionEntry["payload"] });
				return id;
			},
		},
		adapters: {
			prompt: {
				prompt: async () => {
					attempts += 1;
					if (attempts === 1) throw new Error("first attempt failed");
					resumedStageStarted.resolve();
					// The process dies during the resumed attempt: this turn never settles.
					return await new Promise<string>(() => undefined);
				},
			},
		},
	});
	const launched = await runtime.dispatch({ action: "run", workflow: definition.name });
	assert.ok("runId" in launched && launched.runId);
	const runId = launched.runId;
	await jobs.get(runId)?.promise;
	assert.ok(entries.some((entry) => entry.type === "workflow.run.end" && entry.payload?.runId === runId));

	const resumed = await runtime.resumeFailedRun(runId);
	assert.equal(resumed.ok, true, JSON.stringify(resumed));
	assert.equal(resumed.ok && resumed.runId, runId);
	await resumedStageStarted.promise;
	// Snapshot the session as the crashed process left it.
	return { runId, entries: [...entries] };
}

test("restarting the session after a resumed run crashes reports it as crashed (#4858)", async () => {
	const { runId, entries } = await crashDuringResumedAttempt();
	const store = createStore();
	const crashed: string[] = [];

	restoreOnSessionStart({ getEntries: () => entries }, { resumeInFlight: "never", persistRuns: true }, store, {
		onCrashed: (run) => crashed.push(run.runId),
	});

	assert.deepEqual(crashed, [runId]);
	assert.match(store.run(runId)?.error ?? "", /process was interrupted/);
});

test("restarting the session after a resumed run crashes auto-resumes it (#4858)", async () => {
	const { runId, entries } = await crashDuringResumedAttempt();
	const store = createStore();
	const resumed: string[] = [];

	restoreOnSessionStart({ getEntries: () => entries }, { resumeInFlight: "auto", persistRuns: true }, store, {
		onResume: (run) => resumed.push(run.runId),
	});

	assert.deepEqual(resumed, [runId]);
	assert.equal(store.run(runId)?.status, "running");
});
