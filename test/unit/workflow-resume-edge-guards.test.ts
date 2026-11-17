import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import type { PiCommandContext } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	confirmEditedWorkflowDefinition,
	findEditedWorkerEntryModuleReason,
	handleDurableResume,
	type WorkflowRunControlDeps,
} from "../../packages/workflows/src/extension/workflow-durable-resume-command.js";
import { run as executeWorkflow } from "../../packages/workflows/src/runs/foreground/executor.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import {
	recordWorkflowSource,
	workflowDefinitionSource,
	workflowSource,
} from "../../packages/workflows/src/shared/workflow-source.js";
import { definitionDigest } from "../../packages/workflows/src/workers/definitions.js";
import { testRunId } from "../helpers/run-id.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const engineRefusalTail = (id: string) =>
	` Its recorded steps and queued children depend on these, so restore them to resume it, or start a new run. The pool size (localWorkers.count) and the root's own limits (admission.limits and admission.host) can change between resumes. An edited entry module can also be accepted: resume with /workflow resume ${id} --accept-entry-changes, or acceptEntryChanges: true in the SDK, to replay the recorded steps and run the rest of each unfinished child with the edited module.`;

const sampleDefinition = workflow({
	name: "guard-flow",
	description: "Guard coverage workflow",
	inputs: {},
	outputs: {},
	run: async () => ({}),
});

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeTestWorkflowFile(filePath: string, stepValue: string): void {
	writeFileSync(
		filePath,
		[
			'import { workflow } from "@bastani/atomic/workflows";',
			"export default workflow({",
			'  name: "tracked-flow",',
			'  description: "Tracked workflow definition",',
			"  inputs: {},",
			"  outputs: {},",
			"  run: async (ctx) => {",
			`    await ctx.tool("step-1", {}, async () => ${JSON.stringify(stepValue)});`,
			"    return {};",
			"  },",
			"});",
		].join("\n"),
	);
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

beforeEach(async () => {
	store.clear();
	setDurableBackend(await createMemoryTestBackend());
});

afterEach(() => {
	vi.restoreAllMocks();
	stageControlRegistry.clear();
	store.clear();
	setDurableBackend(undefined);
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("workflow resume confirmation and definition source guards (#5256)", () => {
	test("custom confirmation cancels when the generation retires during selection or before custom resolves (#5256)", async () => {
		let generationActive = true;
		let settledByOnSelect: boolean | undefined;
		const selectRetireCtx: PiCommandContext = {
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				notify: () => undefined,
				custom: async (factory) => {
					const baseKb = new KeybindingsManager();
					const customKb = {
						matches: (data: string, action: string) => {
							const matched = baseKb.matches(data, action as never);
							if (matched && action === "tui.select.confirm") {
								generationActive = false;
							}
							return matched;
						},
						getKeys: (action: string) => baseKb.getKeys(action as never),
					};
					const component = await factory({} as never, {} as never, customKb as never, (val) => {
						settledByOnSelect = val === true;
					});
					component.handleInput?.("\r");
					return settledByOnSelect;
				},
			},
		};
		const selectDecision = await confirmEditedWorkflowDefinition(
			selectRetireCtx,
			"Since root wf-1 started, the entry module of workflow definition guard-flow (/w/flow.ts) was edited (sha256 aaaaaaaaaaaa to bbbbbbbbbbbb).",
			() => generationActive,
		);
		assert.equal(settledByOnSelect, false);
		assert.equal(selectDecision, "cancelled");

		let postCustomActive = true;
		const postCustomCtx: PiCommandContext = {
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				notify: () => undefined,
				custom: async (factory) => {
					let settled = false;
					const component = await factory({} as never, {} as never, new KeybindingsManager() as never, (val) => {
						settled = val === true;
					});
					component.handleInput?.("\r");
					postCustomActive = false;
					return settled;
				},
			},
		};
		const postCustomDecision = await confirmEditedWorkflowDefinition(
			postCustomCtx,
			"Since root wf-1 started, the entry module of workflow definition guard-flow (/w/flow.ts) was edited (sha256 aaaaaaaaaaaa to bbbbbbbbbbbb).",
			() => postCustomActive,
		);
		assert.equal(postCustomDecision, "cancelled");
	});

	test("durable refusal retry aborts before re-invoking resumeDurableWorkflow if the generation retires after confirmation (#5256)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);

		const runId = testRunId("retry-retire-durable");
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 1_000,
			updatedAt: 2_000,
			status: "paused",
			completedCheckpoints: 1,
			invocationCwd: process.cwd(),
		});

		const runtime = createExtensionRuntime({ definitions: [sampleDefinition], store });
		const refusalMessage = `Since root ${runId} started, the entry module of worker definition /workspace/worker.ts#default was edited (sha256 aaaaaaaaaaaa to bbbbbbbbbbbb).${engineRefusalTail(runId)}`;
		const resumeSpy = vi
			.spyOn(runtime, "resumeDurableWorkflow")
			.mockImplementation(async (id, opts) =>
				opts?.acceptEntryChanges === true
					? { ok: true, runId: id, workflowId: id, name: sampleDefinition.name, message: `Resumed ${id}` }
					: { ok: false, reason: "startup_failed", message: refusalMessage },
			);

		let generationCurrent = true;
		const ctx: PiCommandContext = {
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				notify: () => undefined,
				custom: (factory) =>
					new Promise<boolean>((resolve) => {
						let settled = false;
						void Promise.resolve(
							factory({} as never, {} as never, new KeybindingsManager() as never, (val) => {
								settled = val === true;
							}),
						).then((component) => {
							component.handleInput?.("\r");
							resolve(settled);
							queueMicrotask(() => {
								generationCurrent = false;
							});
						});
					}),
			},
		};
		const infos: string[] = [];
		const errors: string[] = [];
		const deps: WorkflowRunControlDeps = {
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			isGenerationCurrent: () => generationCurrent,
		};

		await handleDurableResume(
			runId,
			ctx,
			{
				info: (message) => infos.push(message),
				error: (message) => errors.push(message),
			},
			deps,
		);
		assert.equal(resumeSpy.mock.calls.length, 1);
		assert.deepEqual(infos, []);
		assert.deepEqual(errors, []);
	});

	test("persists definitionSource through toMetadata, preserves stored digest until accepted on resume, and updates digest on fork (#5256)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);

		const workDir = makeTempDir("workflow-digest-carriers-");
		const wfDir = join(workDir, ".atomic", "workflows");
		mkdirSync(wfDir, { recursive: true });
		const wfFile = join(wfDir, "tracked-flow.ts");
		writeTestWorkflowFile(wfFile, "v1");
		const digestV1 = await definitionDigest(wfFile);

		const discoveredV1 = await discoverWorkflows({ cwd: workDir, homeDir: workDir, includeBundled: false });
		const defV1 = discoveredV1.registry.get("tracked-flow");
		assert.ok(defV1);

		const runId = testRunId("carrier-run");
		await executeWorkflow(defV1, {}, { runId, cwd: workDir, store, durableBackend: backend });
		await backend.commitWorkflowStatus(runId, "paused", 1, true);

		assert.deepEqual(backend.toMetadata(runId)?.definitionSource, {
			path: wfFile,
			digest: digestV1,
		});
		const unnormalizedTarget = {};
		recordWorkflowSource(unnormalizedTarget, `${wfDir}/./tracked-flow.ts`);
		assert.equal(workflowSource(unnormalizedTarget), wfFile);
		assert.deepEqual(workflowDefinitionSource(unnormalizedTarget), {
			path: wfFile,
			digest: digestV1,
		});
		const windowsTarget = {};
		recordWorkflowSource(windowsTarget, "C:/w/0/.atomic/workflows/tracked-flow.ts");
		assert.equal(workflowSource(windowsTarget), "C:\\w\\0\\.atomic\\workflows\\tracked-flow.ts");

		writeTestWorkflowFile(wfFile, "v2");
		const digestV2 = await definitionDigest(wfFile);
		const discoveredV2 = await discoverWorkflows({ cwd: workDir, homeDir: workDir, includeBundled: false });
		const defV2 = discoveredV2.registry.get("tracked-flow");
		assert.ok(defV2);

		await executeWorkflow(defV2, {}, { runId, cwd: workDir, store, durableBackend: backend });
		await backend.commitWorkflowStatus(runId, "paused", 1, true);
		assert.equal(
			backend.getWorkflow(runId)?.definitionSource?.digest,
			digestV1,
			"resuming without acceptEntryChanges must keep the original recorded definition digest",
		);

		const forked = await forkDurableRun(backend, {
			source: "sdk",
			runId,
			carryMessages: "before",
			cwd: workDir,
			definition: defV2,
		});
		await backend.hydrateWorkflow(forked.runId);
		assert.equal(
			backend.getWorkflow(forked.runId)?.definitionSource?.digest,
			digestV2,
			"forking a run with an updated definition must record the definition digest at fork time",
		);

		await executeWorkflow(
			defV2,
			{},
			{ runId, cwd: workDir, store, durableBackend: backend, acceptEntryChanges: true },
		);
		assert.equal(
			backend.getWorkflow(runId)?.definitionSource?.digest,
			digestV2,
			"resuming with acceptEntryChanges must update the recorded definition digest",
		);
	});

	test("discovery records the workflow file source when stack inference is unavailable and precheck falls back to the registered digest (#5256)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);

		const workDir = makeTempDir("workflow-discovery-fallback-");
		const wfDir = join(workDir, ".atomic", "workflows");
		mkdirSync(wfDir, { recursive: true });
		const wfFile = join(wfDir, "tracked-flow.ts");
		const writeStacklessWorkflowFile = (stepValue: string) => {
			writeFileSync(
				wfFile,
				[
					'import { workflow } from "@bastani/atomic/workflows";',
					"const previousLimit = Error.stackTraceLimit;",
					"Error.stackTraceLimit = 0;",
					"const definition = workflow({",
					'  name: "tracked-flow",',
					'  description: "Tracked workflow definition",',
					"  inputs: {},",
					"  outputs: {},",
					"  run: async (ctx) => {",
					`    await ctx.tool("step-1", {}, async () => ${JSON.stringify(stepValue)});`,
					"    return {};",
					"  },",
					"});",
					"Error.stackTraceLimit = previousLimit;",
					"export default definition;",
				].join("\n"),
			);
		};
		writeStacklessWorkflowFile("v1");
		const digestV1 = await definitionDigest(wfFile);

		const discovered = await discoverWorkflows({ cwd: workDir, homeDir: workDir, includeBundled: false });
		const def = discovered.registry.get("tracked-flow");
		assert.ok(def);
		assert.equal(workflowSource(def), wfFile);
		assert.deepEqual(workflowDefinitionSource(def), { path: wfFile, digest: digestV1 });

		const runId = testRunId("legacy-no-digest-run");
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: "tracked-flow",
			inputs: {},
			createdAt: 1_000,
			updatedAt: 2_000,
			status: "paused",
			completedCheckpoints: 1,
			invocationCwd: workDir,
		});

		const runtime = createExtensionRuntime({ registry: discovered.registry, store, cwd: workDir });
		assert.equal(await findEditedWorkerEntryModuleReason(backend, runId, workDir, runtime), undefined);

		writeStacklessWorkflowFile("v2-edited-after-discovery");
		const reasonAfterEdit = await findEditedWorkerEntryModuleReason(backend, runId, workDir, runtime);
		assert.ok(reasonAfterEdit);
		assert.match(reasonAfterEdit, /the entry module of workflow definition tracked-flow .* was edited/);
	});
});
