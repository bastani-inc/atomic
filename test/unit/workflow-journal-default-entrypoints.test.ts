import assert from "node:assert/strict";
import { join } from "node:path";
import { getAgentDir } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { getDurableBackendProcessOwner } from "../../packages/workflows/src/durable/backend-process-owner.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqliteRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { StorageUnavailableError } from "../../packages/workflows/src/durable/journal/types.js";
import { availableStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { registerWorkflowSlashCommand } from "../../packages/workflows/src/extension/workflow-command-registration.js";
import type { WorkflowCommandHandler } from "../../packages/workflows/src/extension/workflow-command-utils.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { GraphOverlayPort } from "../../packages/workflows/src/tui/overlay-adapter.js";
import { makeDirectorySync, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { buildCtx } from "./slash-dispatch-utils.js";

let directory: string;
let expectedPath: string;
beforeEach(() => {
	setDurableBackend(undefined);
	directory = makeTempDirectory("default-journal-entry-");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(directory, "agent"));
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", undefined);
	expectedPath = join(directory, "workflows", "journal.sqlite");
	assert.equal(getAgentDir(), join(directory, "agent"));
	assert.equal(getDurableBackendProcessOwner().selectedBackends, undefined);
});
afterEach(async () => {
	for (const entry of getDurableBackendProcessOwner().selectedBackends?.values() ?? []) {
		await entry.ready.catch(() => undefined);
		await entry.close?.();
	}
	setDurableBackend(undefined);
	vi.unstubAllEnvs();
	removeTempDirectory(directory);
});

function definition() {
	return workflow({
		name: "default-journal",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("effect", {}, async () => "saved");
			return {};
		},
	});
}
function defaultBackend(store: Store) {
	const backend = availableStoreDurableBackend(store);
	assert.ok(backend instanceof JournalDurableBackend);
	assert.ok(backend.journal instanceof SqliteRunJournal);
	assert.equal(backend.journal.path, expectedPath);
	assert.equal(backend.persistent, true);
	return backend;
}
function resources() {
	const store = createStore();
	return {
		store,
		jobs: createJobTracker(),
		stageControlRegistry: createStageControlRegistry(),
		toolControlRegistry: createToolControlRegistry(),
		stageUiBroker: new StageUiBroker(store),
	};
}

async function settle(owner: ReturnType<typeof resources>): Promise<void> {
	await Promise.all(owner.jobs.runIds().map((id) => owner.jobs.get(id)?.promise));
	const backend = defaultBackend(owner.store);
	assert.equal((await backend.journal.listRuns()).length, 1);
}

test("SDK run defaults to the persistent SQLite journal without an injected backend", async () => {
	const store = createStore();
	const result = await run(definition(), {}, { cwd: directory, store });
	assert.equal(result.status, "completed", JSON.stringify(result));
	assert.equal((await defaultBackend(store).journal.listRuns()).length, 1);
});

test("background run defaults to the persistent SQLite journal without an injected backend", async () => {
	const owner = resources();
	runDetached(definition(), {}, { ...owner, cwd: directory });
	await settle(owner);
});

test("extension dispatch defaults to the persistent SQLite journal without settings", async () => {
	const owner = resources();
	const runtime = createExtensionRuntime({ ...owner, cwd: directory, definitions: [definition()] });
	const result = await runtime.dispatch({ action: "run", workflow: "default-journal" });
	assert.ok("runId" in result && result.runId);
	await settle(owner);
});

for (const hasUI of [true, false]) {
	test(`${hasUI ? "TUI" : "CLI"} slash command defaults to the persistent SQLite journal`, async () => {
		const owner = resources();
		const runtime = createExtensionRuntime({ ...owner, cwd: directory, definitions: [definition()] });
		const handlers = new Map<string, WorkflowCommandHandler>();
		const pi: ExtensionAPI = { registerCommand() {}, sendMessage() {} };
		const overlay: GraphOverlayPort = { open() {}, toggle() {}, close() {} };
		registerWorkflowSlashCommand(pi, handlers, {
			runtimeProxy: runtime,
			runtimeForContext: () => runtime,
			overlay,
			owner,
			reloadWorkflowResources: () => undefined,
			ensureWorkflowResourcesLoaded: () => undefined,
			runWithLifecycleSuppressedForPolicy: (_policy, action) => action(),
			runControl: {
				pi,
				overlay,
				runtimeForContext: () => runtime,
				ensureWorkflowResourcesLoaded: () => undefined,
				owner,
			},
		});
		const handler = handlers.get("workflow");
		assert.ok(handler);
		const { ctx } = buildCtx();
		await handler("default-journal --yes", { ...ctx, cwd: directory, hasUI });
		await settle(owner);
	});
}

test("workflow tool defaults to the persistent SQLite journal without settings", async () => {
	const owner = resources();
	const runtime = createExtensionRuntime({ ...owner, cwd: directory, definitions: [definition()] });
	const execute = makeExecuteWorkflowTool(
		runtime,
		() => undefined,
		() => undefined,
		owner,
	);
	const { ctx } = buildCtx();
	const result = await execute(
		{ action: "run", workflow: "default-journal" },
		{ ...ctx, cwd: directory, hasUI: false },
	);
	assert.ok("runId" in result && result.runId);
	await settle(owner);
});

test("empty workflow status stays local without initializing a journal (#3674)", async () => {
	const owner = resources();
	const runtime = createExtensionRuntime({ ...owner, cwd: directory });
	const execute = makeExecuteWorkflowTool(
		runtime,
		() => undefined,
		() => undefined,
		owner,
	);
	const { ctx } = buildCtx();
	const result = await execute({ action: "status" }, { ...ctx, cwd: directory, hasUI: false });
	assert.ok(result.action === "status");
	assert.deepEqual(result.runs, []);
	assert.equal(getDurableBackendProcessOwner().selectedBackends, undefined);
});

test("resume reopens the default SQLite journal without an injected backend", async () => {
	const def = definition();
	const store = createStore();
	const result = await run(def, {}, { cwd: directory, store });
	assert.equal(result.status, "completed", JSON.stringify(result));
	const backend = defaultBackend(store);
	await backend.setWorkflowStatus(result.runId, "paused", 0, true);
	await backend.close();
	setDurableBackend(undefined);
	assert.equal(getDurableBackendProcessOwner().selectedBackends, undefined);
	const owner = resources();
	const runtime = createExtensionRuntime({ ...owner, cwd: directory, definitions: [def] });
	const resumed = await runtime.resumeDurableWorkflow(result.runId);
	assert.equal(resumed.ok, true);
	await settle(owner);
	assert.equal(defaultBackend(owner.store).getWorkflow(result.runId)?.status, "completed");
});

test("an unopenable default SQLite journal fails without selecting memory", async () => {
	makeDirectorySync(expectedPath, { recursive: true });
	await assert.rejects(run(definition(), {}, { cwd: directory, store: createStore() }), (error: Error) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.path, expectedPath);
		return true;
	});
	assert.equal(getDurableBackendProcessOwner().selectedBackends?.size, 0);
});

test("runtime retries failed initialization but retains a successful journal selection (#3674)", async () => {
	process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = directory;
	const runtime = createExtensionRuntime({ store: createStore(), cwd: directory });
	await assert.rejects(runtime.dispatch({ action: "list" }), (error: Error) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.path, directory);
		return true;
	});
	process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = expectedPath;
	const results = await Promise.all([runtime.dispatch({ action: "list" }), runtime.dispatch({ action: "list" })]);
	assert.deepEqual(results, [
		{ action: "list", items: [] },
		{ action: "list", items: [] },
	]);
	const selected = runtime.durableBackend();
	assert.ok(selected instanceof JournalDurableBackend);
	assert.ok(selected.journal instanceof SqliteRunJournal);
	assert.equal(selected.journal.path, expectedPath);
	process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = directory;
	assert.deepEqual(await runtime.dispatch({ action: "list" }), { action: "list", items: [] });
	assert.equal(runtime.durableBackend(), selected);
});

test("fresh /workflow resume opens the picker before loading saved journal runs (#3674)", async () => {
	const def = definition();
	const previousStore = createStore();
	const saved = await run(def, {}, { cwd: directory, store: previousStore });
	assert.equal(saved.status, "completed", JSON.stringify(saved));
	const previousBackend = defaultBackend(previousStore);
	await previousBackend.setWorkflowStatus(saved.runId, "paused", 0, true);
	await previousBackend.close();
	setDurableBackend(undefined);

	const owner = resources();
	const runtime = createExtensionRuntime({ ...owner, cwd: directory, definitions: [def] });
	const handlers = new Map<string, WorkflowCommandHandler>();
	const pi: ExtensionAPI = { registerCommand() {}, sendMessage() {} };
	const overlay: GraphOverlayPort = { open() {}, toggle() {}, close() {} };
	registerWorkflowSlashCommand(pi, handlers, {
		runtimeProxy: runtime,
		runtimeForContext: () => runtime,
		overlay,
		owner,
		reloadWorkflowResources: () => undefined,
		ensureWorkflowResourcesLoaded: () => undefined,
		runWithLifecycleSuppressedForPolicy: (_policy, action) => action(),
		runControl: {
			pi,
			overlay,
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			owner,
		},
	});
	const handler = handlers.get("workflow");
	assert.ok(handler);
	let opened = false;
	let savedRunListed = false;
	let closePicker: (path: string | undefined) => void = () => {};
	const result = new Promise<string | undefined>((resolve) => {
		closePicker = resolve;
	});
	const { ctx, messages } = buildCtx();
	await handler("resume", {
		...ctx,
		cwd: directory,
		hasUI: true,
		ui: {
			...ctx.ui,
			custom: async () => undefined,
			hostSessionPicker(request) {
				opened = true;
				assert.deepEqual(request.sessions, []);
				assert.equal(availableStoreDurableBackend(owner.store), undefined, "mount must stay storage-free");
				return {
					result,
					close: () => closePicker(undefined),
					update(rows) {
						savedRunListed = rows.some((row) => row.id === saved.runId);
						closePicker(undefined);
					},
					error(message) {
						messages.push(message);
						closePicker(undefined);
					},
				};
			},
		},
	});
	assert.equal(opened, true, messages.join("\n"));
	assert.equal(savedRunListed, true, messages.join("\n"));
	assert.equal(defaultBackend(owner.store).getWorkflow(saved.runId)?.status, "paused");
});
