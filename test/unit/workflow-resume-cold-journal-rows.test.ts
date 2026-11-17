import assert from "node:assert/strict";
import { join } from "node:path";
import { setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal, SqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	RUN_TIMING_CHECKPOINT_NAME,
	RUN_USAGE_CHECKPOINT_NAME,
} from "../../packages/workflows/src/durable/run-timing.js";
import { DURABLE_STAGE_TOPOLOGY_VERSION } from "../../packages/workflows/src/durable/types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createWorkflowResumeProvider } from "../../packages/workflows/src/extension/workflow-resume-provider.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";

const definition = workflow({
	name: "goal",
	description: "Cold journal resume rows",
	inputs: {},
	outputs: {},
	run: async () => ({}),
});

const RUN_ID = "d4e5f6a7-1111-4222-8333-444444444444";
const opened: JournalDurableBackend[] = [];
const dirs: string[] = [];

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(async () => {
	vi.restoreAllMocks();
	stageControlRegistry.clear();
	store.clear();
	setDurableBackend(undefined);
	for (const backend of opened.splice(0)) await backend.close().catch(() => undefined);
	for (const dir of dirs.splice(0)) removeTempDirectory(dir);
});

async function seedFailedRun(path: string, now: number): Promise<void> {
	const writer = await JournalDurableBackend.open(await openSqlRunJournal(path));
	try {
		await writer.commitWorkflowRegistration({
			workflowId: RUN_ID,
			name: definition.name,
			label: "verify worker pool capacity",
			inputs: { goal: "verify worker pool capacity" },
			createdAt: now - 30 * 60_000,
			updatedAt: now - 25 * 60_000,
			status: "running",
			completedCheckpoints: 0,
			pendingPrompts: 0,
			resumable: true,
			invocationCwd: process.cwd(),
		});
		await writer.commitCheckpoint({
			workflowId: RUN_ID,
			kind: "stage",
			checkpointId: "stage:probe",
			replayKey: "stage:probe",
			name: "probe",
			output: "probed",
			startedAt: now - 30 * 60_000,
			endedAt: now - 25 * 60_000,
			durationMs: 300_000,
			completedAt: now - 25 * 60_000,
			topology: {
				version: DURABLE_STAGE_TOPOLOGY_VERSION,
				stageId: "probe",
				parentIds: [],
				order: 1,
				sourceOrder: 1,
				status: "completed",
			},
		});
		await writer.commitCheckpoint({
			kind: "tool",
			workflowId: RUN_ID,
			checkpointId: "run-timing:300000",
			name: RUN_TIMING_CHECKPOINT_NAME,
			argsHash: RUN_TIMING_CHECKPOINT_NAME,
			output: { elapsedMs: 300_000 },
			completedAt: now - 25 * 60_000,
		});
		await writer.commitCheckpoint({
			kind: "tool",
			workflowId: RUN_ID,
			checkpointId: "run-usage:seeded",
			name: RUN_USAGE_CHECKPOINT_NAME,
			argsHash: RUN_USAGE_CHECKPOINT_NAME,
			output: {
				accounting: {
					tokens: 5_000,
					cost: 1.84,
					baseline: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
					perCounter: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			},
			completedAt: now - 25 * 60_000,
		});
		await writer.commitWorkflowStatus(RUN_ID, "failed", 0, true, {
			error: "Error: at capacity: 16/16 pooled workers busy",
			failureRecoverability: "recoverable",
		});
	} finally {
		await writer.close();
	}
}

async function openCold(path: string): Promise<JournalDurableBackend> {
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(path), { runs: [] });
	opened.push(backend);
	return backend;
}

function providerFor(backend: JournalDurableBackend) {
	setDurableBackend(backend);
	const runtime = createExtensionRuntime({ definitions: [definition], store });
	return createWorkflowResumeProvider({
		pi: {},
		overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
		runtimeForContext: () => runtime,
		ensureWorkflowResourcesLoaded: () => undefined,
		context: () => ({ hasUI: true, cwd: process.cwd(), ui: { notify: () => undefined } }),
	});
}

test("hidden completed-only catalogs do not read run overviews until a direct id requests one (#5256)", async () => {
	const dir = makeTempDirectory("resume-hidden-completed-rows-");
	dirs.push(dir);
	const path = join(dir, "journal.sqlite");
	await seedFailedRun(path, Date.now());
	const writer = await JournalDurableBackend.open(await openSqlRunJournal(path));
	try {
		await writer.commitWorkflowStatus(RUN_ID, "completed", 0, false);
	} finally {
		await writer.close();
	}
	const backend = await openCold(path);
	const provider = providerFor(backend);
	const reads = vi.spyOn(backend, "readRunOverviewCheckpoints");
	assert.deepEqual(await provider.listResumeEntries(), []);
	assert.equal(reads.mock.calls.length, 0);
	const rows = await provider.listResumeEntries(RUN_ID);
	assert.equal(rows.length, 1);
	assert.match(rows[0]!.detail ?? "", /stage 1\/1 probe.*5m.*\$1\.84/);
	assert.equal(reads.mock.calls.length, 1);
});

test("a run listed cold from the journal shows its saved stage, elapsed time and cost in /resume (#5256)", async () => {
	const dir = makeTempDirectory("resume-cold-rows-");
	dirs.push(dir);
	const path = join(dir, "journal.sqlite");
	await seedFailedRun(path, Date.now());
	const backend = await openCold(path);
	const provider = providerFor(backend);

	const row = (await provider.listResumeEntries()).find((entry) => entry.id === RUN_ID);

	assert.deepEqual(backend.listCheckpoints(RUN_ID), []);
	assert.ok(row, "the failed run is listed");
	assert.match(row.detail ?? "", /^failed · stage 1\/1 probe · .+ · 5m · \$1\.84 · ✗ at capacity/);
});

test("listing /resume again reads a cold run's stages only after the run changed (#5256)", async () => {
	const dir = makeTempDirectory("resume-cold-rows-");
	dirs.push(dir);
	const path = join(dir, "journal.sqlite");
	const now = Date.now();
	await seedFailedRun(path, now);
	const backend = await openCold(path);
	const provider = providerFor(backend);
	const ranges = vi.spyOn(SqlRunJournal, "readKeyRange");
	const detail = async () => (await provider.listResumeEntries()).find((entry) => entry.id === RUN_ID)?.detail ?? "";

	assert.match(await detail(), /stage 1\/1 probe/);
	const firstReads = ranges.mock.calls.length;
	assert.ok(firstReads > 0, "the first listing reads the run's overview");
	assert.match(await detail(), /stage 1\/1 probe/);
	assert.match(await detail(), /stage 1\/1 probe/);
	assert.equal(ranges.mock.calls.length, firstReads, "an unchanged run is not read again");

	const writer = await JournalDurableBackend.open(await openSqlRunJournal(path));
	try {
		await writer.hydrateWorkflow(RUN_ID);
		await writer.commitCheckpoint({
			workflowId: RUN_ID,
			kind: "stage",
			checkpointId: "stage:verify",
			replayKey: "stage:verify",
			name: "verify",
			output: "verified",
			startedAt: now - 20 * 60_000,
			endedAt: now - 19 * 60_000,
			durationMs: 60_000,
			completedAt: now - 19 * 60_000,
			topology: {
				version: DURABLE_STAGE_TOPOLOGY_VERSION,
				stageId: "verify",
				parentIds: ["probe"],
				order: 2,
				sourceOrder: 2,
				status: "completed",
			},
		});
	} finally {
		await writer.close();
	}

	assert.match(await detail(), /stage 2\/2 verify/);
	assert.equal(ranges.mock.calls.length, 2 * firstReads, "a changed run is read once more");
	assert.match(await detail(), /stage 2\/2 verify/);
	assert.equal(ranges.mock.calls.length, 2 * firstReads);
	assert.deepEqual(backend.listCheckpoints(RUN_ID), []);
});

async function seedPausedRuns(path: string, count: number, now: number): Promise<string[]> {
	const ids = Array.from(
		{ length: count },
		(_, index) => `${String(index).padStart(8, "0")}-1111-4222-8333-444444444444`,
	);
	const writer = await JournalDurableBackend.open(await openSqlRunJournal(path));
	try {
		for (const [index, workflowId] of ids.entries()) {
			const at = now - (index + 1) * 60_000;
			await writer.commitWorkflowRegistration({
				workflowId,
				name: definition.name,
				inputs: {},
				createdAt: at - 60_000,
				updatedAt: at,
				status: "running",
				completedCheckpoints: 0,
				pendingPrompts: 0,
				resumable: true,
				invocationCwd: process.cwd(),
			});
			await writer.commitCheckpoint({
				workflowId,
				kind: "stage",
				checkpointId: "stage:plan",
				replayKey: "stage:plan",
				name: "plan",
				output: "planned",
				startedAt: at - 60_000,
				endedAt: at,
				durationMs: 60_000,
				completedAt: at,
				topology: {
					version: DURABLE_STAGE_TOPOLOGY_VERSION,
					stageId: "plan",
					parentIds: [],
					order: 1,
					sourceOrder: 1,
					status: "completed",
				},
			});
			await writer.commitWorkflowStatus(workflowId, "paused", 0, true);
		}
	} finally {
		await writer.close();
	}
	return ids;
}

test("/resume reads the most recent and the asked-for cold runs first and the rest in the background (#5256)", async () => {
	const dir = makeTempDirectory("resume-cold-rows-");
	dirs.push(dir);
	const path = join(dir, "journal.sqlite");
	const ids = await seedPausedRuns(path, 26, Date.now());
	const oldest = ids[0]!;
	const ranges = vi.spyOn(SqlRunJournal, "readKeyRange");
	const staged = (rows: readonly { readonly id: string; readonly detail?: string }[]) =>
		new Set(rows.filter((row) => /stage 1\/1 plan/.test(row.detail ?? "")).map((row) => row.id));

	const provider = providerFor(await openCold(path));
	const rows = await provider.listResumeEntries();
	assert.deepEqual(
		[...staged(rows)].sort(),
		rows
			.slice(0, 24)
			.map((row) => row.id)
			.sort(),
		"the 24 most recent runs are read before listing",
	);
	const readsPerRun = () => {
		const counts = new Map<string, number>();
		for (const call of ranges.mock.calls) counts.set(call[1], (counts.get(call[1]) ?? 0) + 1);
		return counts;
	};
	const perRun = readsPerRun().get(rows[0]!.id);
	await vi.waitFor(() =>
		assert.deepEqual(
			[...readsPerRun().values()],
			Array.from({ length: ids.length }, () => perRun),
		),
	);
	const settled = ranges.mock.calls.length;
	assert.equal(staged(await provider.listResumeEntries()).size, ids.length);
	assert.equal(ranges.mock.calls.length, settled, "runs read in the background are not read again");

	const asked = providerFor(await openCold(path));
	assert.ok(staged(await asked.listResumeEntries(oldest.slice(0, 8))).has(oldest), "the asked-for run is read first");
});
