import assert from "node:assert/strict";
import { join } from "node:path";
import { getAgentDir } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { getAvailableDurableBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqliteRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { StorageUnavailableError } from "../../packages/workflows/src/durable/journal/types.js";
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
import { createStore } from "../../packages/workflows/src/shared/store.js";
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
	assert.equal(getAvailableDurableBackend(), undefined);
});
afterEach(async () => {
	const backend = getAvailableDurableBackend();
	if (backend instanceof JournalDurableBackend) await backend.close();
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
function defaultBackend() {
	const backend = getAvailableDurableBackend();
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
	const backend = defaultBackend();
	assert.equal((await backend.journal.listRuns()).length, 1);
}

test("SDK run defaults to the persistent SQLite journal without an injected backend", async () => {
	const result = await run(definition(), {}, { cwd: directory, store: createStore() });
	assert.equal(result.status, "completed", JSON.stringify(result));
	assert.equal((await defaultBackend().journal.listRuns()).length, 1);
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

test("resume reopens the default SQLite journal without an injected backend", async () => {
	const def = definition();
	const result = await run(def, {}, { cwd: directory, store: createStore() });
	assert.equal(result.status, "completed", JSON.stringify(result));
	const backend = defaultBackend();
	await backend.setWorkflowStatus(result.runId, "paused", 0, true);
	await backend.close();
	setDurableBackend(undefined);
	assert.equal(getAvailableDurableBackend(), undefined);
	const owner = resources();
	const runtime = createExtensionRuntime({ ...owner, cwd: directory, definitions: [def] });
	const resumed = await runtime.resumeDurableWorkflow(result.runId);
	assert.equal(resumed.ok, true);
	await settle(owner);
	assert.equal(defaultBackend().getWorkflow(result.runId)?.status, "completed");
});

test("an unopenable default SQLite journal fails without selecting memory", async () => {
	makeDirectorySync(expectedPath, { recursive: true });
	await assert.rejects(run(definition(), {}, { cwd: directory, store: createStore() }), (error: Error) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.path, expectedPath);
		return true;
	});
	assert.equal(getAvailableDurableBackend(), undefined);
});
