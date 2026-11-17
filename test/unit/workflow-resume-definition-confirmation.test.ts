import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import type { PiCommandContext } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	cleanEntryChangeReason,
	deleteWorkflowResumeEntry,
	findEditedWorkerEntryModuleReason,
	handleDurableResume,
	isEditedEntryModuleRefusal,
	resumeFailedRunWithConfirmation,
	WORKFLOW_DEFINITION_CHANGED_TITLE,
	type WorkflowRunControlDeps,
} from "../../packages/workflows/src/extension/workflow-durable-resume-command.js";
import { createWorkflowResumeProvider } from "../../packages/workflows/src/extension/workflow-resume-provider.js";
import { run as executeWorkflow } from "../../packages/workflows/src/runs/foreground/executor.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest } from "../../packages/workflows/src/workers/definitions.js";
import { refusedResourceChanges } from "../../packages/workflows/src/workers/public-pool.js";
import { testRunId } from "../helpers/run-id.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const sampleDefinition = workflow({
	name: "sample-confirm-wf",
	description: "Sample workflow for confirmation tests",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("step", {}, async () => "ok");
		return {};
	},
});

const engineRefusalTail = (id: string) =>
	` Its recorded steps and queued children depend on these, so restore them to resume it, or start a new run. The pool size (localWorkers.count) and the root's own limits (admission.limits and admission.host) can change between resumes. An edited entry module can also be accepted: resume with /workflow resume ${id} --accept-entry-changes, or acceptEntryChanges: true in the SDK, to replay the recorded steps and run the rest of each unfinished child with the edited module.`;

describe("workflow resume definition confirmation and refusal handling (#5256)", () => {
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	beforeEach(async () => {
		store.clear();
		setDurableBackend(await createMemoryTestBackend());
	});

	afterEach(() => {
		stageControlRegistry.clear();
		store.clear();
		setDurableBackend(undefined);
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	test("persists workflow definition source digest on launch and prompts when the workflow source file is edited (#5256)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);

		const workDir = makeTempDir("wf-def-edit-");
		const wfDir = join(workDir, ".atomic", "workflows");
		mkdirSync(wfDir, { recursive: true });
		const wfFile = join(wfDir, "slowflow.ts");
		writeFileSync(
			wfFile,
			[
				'import { workflow } from "@bastani/atomic/workflows";',
				"export default workflow({",
				'  name: "slowflow",',
				'  description: "Fix the shipping benchmark",',
				"  inputs: {},",
				"  outputs: {},",
				"  run: async (ctx) => {",
				'    await ctx.tool("step-1", {}, async () => "v1");',
				'    await ctx.ui.confirm("Continue?", "Pause point");',
				"    return {};",
				"  },",
				"});",
			].join("\n"),
		);

		const initialDigest = await definitionDigest(wfFile);
		const discovered1 = await discoverWorkflows({ cwd: workDir, homeDir: workDir, includeBundled: false });
		const defV1 = discovered1.registry.get("slowflow");
		assert.ok(defV1, "discovered slowflow v1");

		writeFileSync(
			wfFile,
			[
				'import { workflow } from "@bastani/atomic/workflows";',
				"export default workflow({",
				'  name: "slowflow",',
				'  description: "Fix the shipping benchmark",',
				"  inputs: {},",
				"  outputs: {},",
				"  run: async (ctx) => {",
				'    await ctx.tool("step-1", {}, async () => "v1");',
				'    await ctx.tool("step-2", {}, async () => "v2-edited");',
				"    return {};",
				"  },",
				"});",
			].join("\n"),
		);
		const editedDigest = await definitionDigest(wfFile);
		assert.notEqual(editedDigest, initialDigest);

		const runId = testRunId("slowflow-run");
		await executeWorkflow(
			defV1,
			{},
			{
				runId,
				cwd: workDir,
				store,
				durableBackend: backend,
			},
		);

		await backend.commitWorkflowStatus(runId, "paused", 1, true);
		store.clear();

		const persistedHandle = backend.getWorkflow(runId);
		assert.ok(
			persistedHandle?.definitionSource,
			"launch must persist definitionSource of the executed v1 definition",
		);
		assert.equal(persistedHandle.definitionSource.digest, initialDigest);

		const relocatedDir = makeTempDir("wf-def-relocated-");
		const relocatedWfDir = join(relocatedDir, ".atomic", "workflows");
		mkdirSync(relocatedWfDir, { recursive: true });
		writeFileSync(
			join(relocatedWfDir, "slowflow.ts"),
			[
				'import { workflow } from "@bastani/atomic/workflows";',
				"export default workflow({",
				'  name: "slowflow",',
				'  description: "Fix the shipping benchmark",',
				"  inputs: {},",
				"  outputs: {},",
				"  run: async (ctx) => {",
				'    await ctx.tool("step-1", {}, async () => "v1");',
				'    await ctx.ui.confirm("Continue?", "Pause point");',
				"    return {};",
				"  },",
				"});",
			].join("\n"),
		);
		const relocatedReason = await findEditedWorkerEntryModuleReason(backend, runId, relocatedDir);
		assert.equal(relocatedReason, undefined, "relocated worktree with identical bytes must not false-prompt");

		const editedReason = await findEditedWorkerEntryModuleReason(backend, runId, workDir);
		assert.ok(editedReason, "edited workflow source must produce a precheck reason");
		assert.match(editedReason, /the entry module of workflow definition .+ was edited/i);

		const runtime = createExtensionRuntime({ registry: discovered1.registry, store, cwd: workDir });

		const provider = createWorkflowResumeProvider({
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			context: () => ({ hasUI: true, cwd: workDir, ui: { notify: () => undefined } }),
		});

		let promptedTitle = "";
		const customCtx: PiCommandContext = {
			hasUI: true,
			cwd: workDir,
			ui: {
				notify: () => undefined,
				custom: async (factory) => {
					let result: boolean | undefined;
					const component = await factory({} as never, {} as never, new KeybindingsManager() as never, (val) => {
						result = val === true;
					});
					promptedTitle = component.render(120).join("\n");
					component.handleInput?.("\r");
					return result;
				},
			},
		};
		await provider.resumeFromPicker(runId, customCtx);
		assert.match(promptedTitle, new RegExp(WORKFLOW_DEFINITION_CHANGED_TITLE));

		await vi.waitFor(() => {
			const step2 = backend
				.listCheckpoints(runId)
				.find((checkpoint) => checkpoint.kind === "tool" && checkpoint.name === "step-2");
			assert.ok(
				step2 && step2.kind === "tool",
				"resumed workflow must execute step-2 from the edited v2 definition",
			);
			assert.equal(step2.output, "v2-edited");
		});
		assert.equal(backend.getWorkflow(runId)?.definitionSource?.digest, editedDigest);

		const reboundFile = join(workDir, "rebound-slowflow.ts");
		writeFileSync(
			reboundFile,
			[
				'import { workflow } from "@bastani/atomic/workflows";',
				"export default workflow({",
				'  name: "slowflow",',
				'  description: "Rebound workflow file",',
				"  inputs: {},",
				"  outputs: {},",
				"  run: async (ctx) => {",
				'    await ctx.tool("step-1", {}, async () => "v3-rebound");',
				"    return {};",
				"  },",
				"});",
			].join("\n"),
		);
		const discoveredRebound = await discoverWorkflows({
			cwd: workDir,
			homeDir: workDir,
			includeBundled: false,
			config: { projectWorkflows: [reboundFile] },
		});
		const reboundRuntime = createExtensionRuntime({ registry: discoveredRebound.registry, store, cwd: workDir });
		const reboundReason = await findEditedWorkerEntryModuleReason(backend, runId, workDir, reboundRuntime);
		assert.ok(
			reboundReason,
			"rebound workflow definition path with new bytes must prompt even while old file still exists unchanged",
		);
	});

	test("isEditedEntryModuleRefusal matches real engine refusals with dotted module paths and rejects mixed placement or added definitions (#5256)", () => {
		const buildEngineMessage = (
			saved: Parameters<typeof refusedResourceChanges>[0],
			current: Parameters<typeof refusedResourceChanges>[1],
		) =>
			`Since root wf-1 started, ${refusedResourceChanges(saved, current, undefined)
				.map((c) => c.description)
				.join("; ")}.${engineRefusalTail("wf-1")}`;

		const saved = {
			definitions: [
				{ path: "/w/a.ts", exportName: "default", digest: "a".repeat(64) },
				{ path: "/home/me/my.proj/b.mjs", exportName: "workerB", digest: "c".repeat(64) },
			],
			localWorkers: { count: 2, definitions: [] },
		};
		const editedBoth = {
			...saved,
			definitions: [
				{ path: "/w/a.ts", exportName: "default", digest: "b".repeat(64) },
				{ path: "/home/me/my.proj/b.mjs", exportName: "workerB", digest: "d".repeat(64) },
			],
		};
		const editedPlusAdded = {
			...editedBoth,
			definitions: [...editedBoth.definitions, { path: "/w/c.ts", exportName: "default", digest: "e".repeat(64) }],
		};
		const editedPlusSetting = {
			...editedBoth,
			admission: { userLimits: { session: 3 } },
		};

		assert.equal(isEditedEntryModuleRefusal(buildEngineMessage(saved, editedBoth)), true);
		assert.equal(isEditedEntryModuleRefusal(buildEngineMessage(saved, editedPlusAdded)), false);
		assert.equal(isEditedEntryModuleRefusal(buildEngineMessage(saved, editedPlusSetting)), false);

		const mixedPlacement = `Invalid worker placement configuration: workers.placement from sdk (changed-on-resume): ${refusedResourceChanges(
			saved,
			editedBoth,
			undefined,
		)
			.map((c) => c.description)
			.join("; ")}; workers.placement changed from "a" to "b". Resume with the root's recorded placement.`;
		assert.equal(isEditedEntryModuleRefusal(mixedPlacement), false);

		const cleaned = cleanEntryChangeReason(buildEngineMessage(saved, editedBoth));
		assert.equal(
			cleaned,
			"Since root wf-1 started, the entry module of worker definition /w/a.ts#default was edited (sha256 aaaaaaaaaaaa to bbbbbbbbbbbb); the entry module of worker definition /home/me/my.proj/b.mjs#workerB was edited (sha256 cccccccccccc to dddddddddddd).",
		);
	});

	test("engine refusal retry prompts and retries with acceptEntryChanges for both durable and failed runs, and does not prompt on mixed placement errors (#5256)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);

		const runId = testRunId("retry-durable");
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
		const dottedRefusal = `Since root ${runId} started, the entry module of worker definition /workspace/my.proj/worker-def.ts#default was edited (sha256 aaaaaaaaaaaa to bbbbbbbbbbbb).${engineRefusalTail(runId)}`;
		const resumeSpy = vi
			.spyOn(runtime, "resumeDurableWorkflow")
			.mockImplementation(async (id, opts) =>
				opts?.acceptEntryChanges === true
					? { ok: true, runId: id, workflowId: id, name: sampleDefinition.name, message: `Resumed ${id}` }
					: { ok: false, reason: "startup_failed", message: dottedRefusal },
			);

		let prompted = 0;
		const enterCtx: PiCommandContext = {
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				notify: () => undefined,
				custom: async (factory) => {
					prompted++;
					let result: boolean | undefined;
					const component = await factory({} as never, {} as never, new KeybindingsManager() as never, (val) => {
						result = val === true;
					});
					component.handleInput?.("\r");
					return result;
				},
			},
		};
		const infos: string[] = [];
		const errors: string[] = [];
		const reporter = {
			info: (m: string) => {
				infos.push(m);
			},
			error: (m: string) => {
				errors.push(m);
			},
		};
		const deps: WorkflowRunControlDeps = {
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
		};

		await handleDurableResume(runId, enterCtx, reporter, deps);
		assert.equal(prompted, 1, "durable retry must prompt on dotted worker path refusal");
		assert.equal(resumeSpy.mock.calls.length, 2);
		assert.equal(resumeSpy.mock.calls[1]![1]?.acceptEntryChanges, true);
		assert.deepEqual(errors, []);

		const failedRunSpy = vi
			.spyOn(runtime, "resumeFailedRun")
			.mockImplementation(async (id, _stageId, opts) =>
				opts?.acceptEntryChanges === true
					? { ok: true, runId: id, sourceRunId: id, message: `Resumed failed ${id}` }
					: { ok: false, reason: "insufficient_state", message: dottedRefusal },
			);
		prompted = 0;
		await resumeFailedRunWithConfirmation(runId, undefined, enterCtx, reporter, deps, runtime);
		assert.equal(prompted, 1, "failed-run retry must prompt on dotted worker path refusal");
		assert.equal(failedRunSpy.mock.calls.length, 2);
		assert.equal(failedRunSpy.mock.calls[1]![2]?.acceptEntryChanges, true);

		const mixedPlacementMsg =
			'Invalid worker placement configuration: workers.placement from sdk (changed-on-resume): the entry module of worker definition /workspace/worker.ts#default was edited (sha256 aaaaaaaaaaaa to bbbbbbbbbbbb); workers.placement changed from "shared" to "local".';
		failedRunSpy.mockResolvedValue({ ok: false, reason: "insufficient_state", message: mixedPlacementMsg });
		prompted = 0;
		await resumeFailedRunWithConfirmation(runId, undefined, enterCtx, reporter, deps, runtime);
		assert.equal(prompted, 0, "mixed placement error must not prompt");
		assert.equal(errors.at(-1), mixedPlacementMsg);
	});

	test("cross-project and definition-change confirmations abort when generation retires mid-prompt (#5256)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);

		const runId = testRunId("guard-run");
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 1_000,
			updatedAt: 2_000,
			status: "paused",
			completedCheckpoints: 1,
			invocationCwd: "/other/project",
		});

		const runtime = createExtensionRuntime({ definitions: [sampleDefinition], store });
		let generationCurrent = true;
		let crossProjectApproved: boolean | undefined;
		const resumeSpy = vi.spyOn(runtime, "resumeDurableWorkflow").mockImplementation(async (id, opts) => {
			if (opts?.confirmCrossProjectFork) {
				crossProjectApproved = await opts.confirmCrossProjectFork("/other/project");
			}
			return { ok: true, runId: id, workflowId: id, name: sampleDefinition.name, message: `Resumed ${id}` };
		});

		const ctx: PiCommandContext = {
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				notify: () => undefined,
				confirm: async () => {
					generationCurrent = false;
					return true;
				},
			},
		};
		const deps: WorkflowRunControlDeps = {
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			isGenerationCurrent: () => generationCurrent,
		};
		await handleDurableResume(runId, ctx, { info: () => undefined, error: () => undefined }, deps);
		assert.equal(
			crossProjectApproved,
			false,
			"cross-project confirm must reject when generation retires during confirm",
		);

		const workDir = makeTempDir("post-confirm-recheck-");
		const workerFile = join(workDir, "worker.ts");
		writeFileSync(workerFile, "export default { v: 1 };\n");
		const digestV1 = await definitionDigest(workerFile);
		writeFileSync(workerFile, "export default { v: 2 };\n");
		const editedId = testRunId("edited-post-confirm");
		await backend.commitWorkflowRegistration({
			workflowId: editedId,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 3_000,
			updatedAt: 4_000,
			status: "paused",
			completedCheckpoints: 1,
			invocationCwd: workDir,
			resources: { definitions: [{ path: workerFile, exportName: "default", digest: digestV1 }] },
		});

		resumeSpy.mockClear();
		const failedSpy = vi.spyOn(runtime, "resumeFailedRun");
		let checkCount = 0;
		const flipAfterConfirmDeps: WorkflowRunControlDeps = {
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			isGenerationCurrent: () => {
				checkCount++;
				return checkCount <= 3;
			},
		};
		const confirmCtx: PiCommandContext = {
			hasUI: true,
			cwd: workDir,
			ui: {
				notify: () => undefined,
				confirm: async () => true,
			},
		};
		const infos: string[] = [];
		const postConfirmReporter = {
			info: (m: string) => {
				infos.push(m);
			},
			error: () => undefined,
		};
		await handleDurableResume(editedId, confirmCtx, postConfirmReporter, flipAfterConfirmDeps);
		assert.equal(
			resumeSpy.mock.calls.length,
			0,
			"post-confirm recheck must prevent resumeDurableWorkflow when generation retired",
		);
		assert.deepEqual(infos, []);

		checkCount = 0;
		await resumeFailedRunWithConfirmation(
			editedId,
			undefined,
			confirmCtx,
			postConfirmReporter,
			flipAfterConfirmDeps,
			runtime,
		);
		assert.equal(
			failedSpy.mock.calls.length,
			0,
			"post-confirm recheck must prevent resumeFailedRun when generation retired",
		);
	});

	test("deleteWorkflowResumeEntry refuses in-session paused or active runs even when durable status is paused (#5256)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);

		const livePausedId = testRunId("in-session-paused");
		await backend.commitWorkflowRegistration({
			workflowId: livePausedId,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 1_000,
			updatedAt: 2_000,
			status: "paused",
			completedCheckpoints: 1,
			invocationCwd: process.cwd(),
		});
		store.recordRunStart({
			id: livePausedId,
			name: sampleDefinition.name,
			status: "paused",
			startedAt: 1_000,
			endedAt: 2_000,
			inputs: {},
			stages: [],
			toolNodes: [],
		});

		const pausedOutcome = await deleteWorkflowResumeEntry(livePausedId, store);
		assert.equal(pausedOutcome.ok, false);

		store.recordRunStart({
			id: livePausedId,
			name: sampleDefinition.name,
			status: "running",
			startedAt: 1_000,
			endedAt: 2_000,
			exitReason: "quit",
			inputs: {},
			stages: [],
			toolNodes: [],
		});
		const quitOutcome = await deleteWorkflowResumeEntry(livePausedId, store);
		assert.equal(quitOutcome.ok, false, "in-session quit run with endedAt set must be refused as in-flight");

		store.recordRunStart({
			id: livePausedId,
			name: sampleDefinition.name,
			status: "failed",
			startedAt: 1_000,
			endedAt: 2_000,
			inputs: {},
			stages: [],
			toolNodes: [],
		});
		const endedFailedOutcome = await deleteWorkflowResumeEntry(livePausedId, store);
		assert.equal(endedFailedOutcome.ok, true);
	});
});
