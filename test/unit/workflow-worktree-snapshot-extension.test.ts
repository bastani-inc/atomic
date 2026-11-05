import assert from "node:assert/strict";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, isWorkspaceConfigError } from "@bastani/atomic";
import { afterEach, beforeEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { releaseDurableBackendsHeldBy } from "../../packages/workflows/src/durable/backend-process-owner.js";
import { listWorkflowSnapshotBoundaries } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { closeSnapshotJournals, openSqlSnapshotJournal } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
let priorAgentDir: string | undefined;
const stores: ReturnType<typeof createStore>[] = [];
beforeEach(() => {
	sandbox = new GitSandbox();
	priorAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = sandbox.path("agent");
});
afterEach(async () => {
	await closeSnapshotJournals();
	for (const store of stores.splice(0)) await releaseDurableBackendsHeldBy(store);
	if (priorAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = priorAgentDir;
	sandbox.dispose();
});

function runtimeWith(options: Parameters<typeof createExtensionRuntime>[0]) {
	const store = createStore();
	stores.push(store);
	return { store, runtime: createExtensionRuntime({ store, journal: { memory: true }, ...options }) };
}

test("the extension runtime rejects invalid snapshot settings from the settings it was given (#4245)", async () => {
	const { runtime } = runtimeWith({
		registry: createRegistry([]),
		resolveJournalSettings: () => ({ snapshots: { fullEvery: 0 } }),
	});
	await assert.rejects(
		runtime.prepareDurableCatalog!(),
		(error: unknown) =>
			isWorkspaceConfigError(error) &&
			error.code === "invalid-setting" &&
			error.source === "settings" &&
			error.field === "snapshots.fullEvery",
	);
});

test("the extension runtime starts with no resolved settings, or settings without a snapshots section (#4245)", async () => {
	for (const options of [{}, { resolveJournalSettings: () => undefined }, { resolveJournalSettings: () => ({}) }]) {
		const { runtime } = runtimeWith({ registry: createRegistry([]), ...options });
		const catalog = await runtime.prepareDurableCatalog?.();
		assert.deepEqual(catalog?.resumable, []);
	}
});

test("the extension runtime opens its journal once and re-checks only the settings on later calls (#4245)", async () => {
	let resolutions = 0;
	const { runtime } = runtimeWith({
		registry: createRegistry([]),
		resolveJournalSettings: () => {
			resolutions++;
			return { snapshots: { maxFileBytes: 2048 } };
		},
	});
	await runtime.prepareDurableCatalog!();
	const opened = runtime.durableBackend();
	await runtime.prepareDurableCatalog!();
	assert.equal(runtime.durableBackend(), opened, "the second call reuses the backend the first opened");
	assert.ok(resolutions >= 2, "settings are resolved again on every call");
});

test("runs the extension launches carry the snapshot settings resolved for the session (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournal(sandbox.path("journal.sqlite"));
	const definition = workflow({
		name: "launched",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				sandbox.write(`${ctx.cwd}/a.txt`, "a\n");
				return "done";
			});
			return {};
		},
	});
	const jobs = createJobTracker();
	const { runtime } = runtimeWith({
		registry: createRegistry([definition]),
		journal: { database: fixture.database },
		jobs,
		cwd: clone,
		resolveJournalSettings: () => ({ snapshots: { maxFileBytes: 4096 } }),
	});
	const launched = await runtime.dispatch({ action: "run", workflow: "launched", inputs: {} });
	assert.equal(launched.action, "run");
	if (launched.action !== "run") return;
	await jobs.get(launched.runId)?.promise;
	const expected = { ...DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, maxFileBytes: 4096 };
	assert.deepEqual(runtime.durableBackend().getWorkflow(launched.runId)?.snapshots, expected);
	const boundaries = await listWorkflowSnapshotBoundaries(fixture.journal, launched.runId);
	assert.equal(boundaries.length, 1);
	await releaseDurableBackendsHeldBy(stores[0]!);
	await fixture.database.close();
});
