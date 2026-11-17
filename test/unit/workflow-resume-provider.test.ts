import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { PiCommandContext } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	WORKFLOW_DEFINITION_CHANGED_TITLE,
	type WorkflowRunControlDeps,
} from "../../packages/workflows/src/extension/workflow-durable-resume-command.js";
import { createWorkflowResumeProvider } from "../../packages/workflows/src/extension/workflow-resume-provider.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest } from "../../packages/workflows/src/workers/definitions.js";
import { testRunId } from "../helpers/run-id.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const sampleDefinition = workflow({
	name: "sample-resume-wf",
	description: "Sample workflow for unified resume provider",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("step", {}, async () => "ok");
		return {};
	},
});

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");
}

describe("workflow resume provider for unified /resume (#5256)", () => {
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

	test("lists resumable live, durable and completed runs with two-line metadata and canDelete flags while excluding active runs", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);

		const activeId = testRunId("active-run");
		const livePausedId = testRunId("live-paused");
		const durableId = testRunId("durable-paused");
		const completedId = testRunId("completed-done");

		store.recordRunStart({
			id: activeId,
			name: sampleDefinition.name,
			status: "running",
			startedAt: 1_000,
			inputs: {},
			stages: [],
			toolNodes: [],
		});
		store.recordRunStart({
			id: livePausedId,
			name: sampleDefinition.name,
			status: "paused",
			startedAt: 2_000,
			pausedAt: 3_000,
			inputs: {},
			stages: [
				{
					id: "s1",
					name: "stage-one",
					status: "paused",
					startedAt: 2_000,
					parentIds: [],
					toolEvents: [],
				},
			],
			toolNodes: [],
		});
		stageControlRegistry.register({
			runId: livePausedId,
			stageId: "s1",
			stageName: "stage-one",
			status: "paused",
			sessionId: undefined,
			sessionFile: undefined,
			isStreaming: false,
			messages: [],
			ensureAttached: async () => undefined,
			prompt: async () => undefined,
			steer: async () => undefined,
			followUp: async () => undefined,
			pause: async () => undefined,
			resume: async () => undefined,
			subscribe: () => () => undefined,
		});
		await backend.commitWorkflowRegistration({
			workflowId: livePausedId,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 2_000,
			updatedAt: 3_000,
			status: "paused",
			completedCheckpoints: 1,
			invocationCwd: process.cwd(),
		});
		await backend.commitWorkflowRegistration({
			workflowId: durableId,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 4_000,
			updatedAt: 5_000,
			status: "paused",
			completedCheckpoints: 2,
			invocationCwd: process.cwd(),
			summary: "Paused after stage two",
		});
		await backend.commitWorkflowRegistration({
			workflowId: completedId,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 6_000,
			updatedAt: 7_000,
			status: "completed",
			completedCheckpoints: 1,
			invocationCwd: process.cwd(),
			summary: "Finished all stages",
		});
		await backend.commitCheckpoint({
			topology: { version: 1, nodeId: "tool:done-hash", ordinal: 1, order: 1, parentIds: [] },
			kind: "tool",
			workflowId: completedId,
			checkpointId: "tool:done",
			name: "done",
			argsHash: "done-hash",
			output: true,
			completedAt: 7_000,
		});
		store.recordRunStart({
			id: completedId,
			name: sampleDefinition.name,
			status: "completed",
			startedAt: 6_000,
			endedAt: 7_000,
			inputs: {},
			stages: [],
			toolNodes: [],
		});

		const runtime = createExtensionRuntime({ definitions: [sampleDefinition], store });
		const provider = createWorkflowResumeProvider({
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			context: () => ({ hasUI: true, cwd: process.cwd(), ui: { notify: () => undefined } }),
		});

		const rows = await provider.listResumeEntries();
		assert.deepEqual(
			rows.map((row) => row.id),
			[completedId, durableId, livePausedId],
		);
		assert.ok(!rows.some((row) => row.id === activeId), "actively running workflow must be excluded");

		const liveRow = rows.find((row) => row.id === livePausedId)!;
		const durableRow = rows.find((row) => row.id === durableId)!;
		const completedRow = rows.find((row) => row.id === completedId)!;
		assert.equal(liveRow.canDelete, false);
		assert.equal(durableRow.canDelete, true);
		assert.equal(completedRow.canDelete, true);
		assert.ok(durableRow.title?.includes(sampleDefinition.name));
		assert.ok(durableRow.detail?.includes("paused"));
	});

	test("targeted listResumeEntries(target) finds a cross-project failed run and resumeFromPicker prompts for cross-project fork confirmation", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		const otherProjectDir = makeTempDir("resume-other-proj-");
		const crossProjectId = testRunId("cross-project-failed");

		await backend.commitWorkflowRegistration({
			workflowId: crossProjectId,
			name: "other-project-only-wf",
			inputs: {},
			createdAt: 1_000,
			updatedAt: 2_000,
			status: "failed",
			resumable: true,
			completedCheckpoints: 1,
			invocationCwd: otherProjectDir,
			error: "transient failure in other project",
		});

		const runtime = createExtensionRuntime({ definitions: [sampleDefinition], store });
		const resumeSpy = vi.spyOn(runtime, "resumeDurableWorkflow").mockImplementation(async (_id, options) => {
			if (options?.confirmCrossProjectFork) {
				const confirmed = await options.confirmCrossProjectFork(otherProjectDir);
				if (!confirmed) {
					return {
						ok: false,
						reason: "different_project",
						message: "Workflow resume cancelled; the source run was not changed.",
					};
				}
			}
			return {
				ok: true,
				runId: crossProjectId,
				workflowId: crossProjectId,
				name: "other-project-only-wf",
				message: `Forked workflow ${crossProjectId} into the current directory.`,
			};
		});

		const provider = createWorkflowResumeProvider({
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			context: () => ({ hasUI: true, cwd: process.cwd(), ui: { notify: () => undefined } }),
		});

		// Default picker catalog (no target) omits failed runs whose definition is not in the current project registry.
		const defaultRows = await provider.listResumeEntries();
		assert.equal(
			defaultRows.some((row) => row.id === crossProjectId),
			false,
		);

		// Targeted lookup (for /resume <id>) retains the cross-project run so the host routes it to resumeFromPicker.
		const targetedRows = await provider.listResumeEntries(crossProjectId.slice(0, 8));
		assert.equal(
			targetedRows.some((row) => row.id === crossProjectId),
			true,
		);

		const confirmPrompts: Array<{ title: string; message: string }> = [];
		const ctx: PiCommandContext = {
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				notify: () => undefined,
				confirm: async (title, message) => {
					confirmPrompts.push({ title, message });
					return true;
				},
			},
		};
		await provider.resumeFromPicker(crossProjectId.slice(0, 8), ctx);
		assert.equal(confirmPrompts.length, 1);
		assert.match(confirmPrompts[0]!.message, /Workflow run found in different project:/);
		assert.equal(resumeSpy.mock.calls.length, 1);
	});

	test("resumeFromPicker resumes by full UUID, picker path or unique 8-hex prefix, opens completed runs read-only, and rejects unknown IDs or flags", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);

		const durableId = "abcdef12-1111-4111-8111-111111111111";
		const completedId = "bcdef123-2222-4222-8222-222222222222";

		await backend.commitWorkflowRegistration({
			workflowId: durableId,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 1_000,
			updatedAt: 2_000,
			status: "paused",
			completedCheckpoints: 1,
			invocationCwd: process.cwd(),
		});
		await backend.commitWorkflowRegistration({
			workflowId: completedId,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 3_000,
			updatedAt: 4_000,
			status: "completed",
			completedCheckpoints: 1,
			invocationCwd: process.cwd(),
		});
		await backend.commitCheckpoint({
			topology: { version: 1, nodeId: "tool:done-hash", ordinal: 1, order: 1, parentIds: [] },
			kind: "tool",
			workflowId: completedId,
			checkpointId: "tool:done",
			name: "done",
			argsHash: "done-hash",
			output: true,
			completedAt: 4_000,
		});
		store.recordRunStart({
			id: completedId,
			name: sampleDefinition.name,
			status: "completed",
			startedAt: 3_000,
			endedAt: 4_000,
			inputs: {},
			stages: [],
			toolNodes: [],
		});

		const openedRuns: string[] = [];
		const runtime = createExtensionRuntime({ definitions: [sampleDefinition], store });
		const resumeSpy = vi.spyOn(runtime, "resumeDurableWorkflow").mockResolvedValue({
			ok: true,
			runId: durableId,
			workflowId: durableId,
			name: sampleDefinition.name,
			message: `Resuming ${durableId}`,
		});

		const provider = createWorkflowResumeProvider({
			pi: {},
			overlay: {
				open: (runId) => {
					if (runId) openedRuns.push(runId);
				},
				toggle: () => undefined,
				close: () => undefined,
			},
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			context: () => ({ hasUI: true, cwd: process.cwd(), ui: { notify: () => undefined } }),
		});

		await provider.resumeFromPicker("abcdef12");
		assert.equal(resumeSpy.mock.calls.length, 1);
		assert.equal(resumeSpy.mock.calls[0]![0], durableId);

		await provider.resumeFromPicker(`workflow-durable:${durableId}`);
		assert.equal(resumeSpy.mock.calls.length, 2);

		// Completed run opens read-only in the overlay without calling resumeDurableWorkflow.
		await provider.resumeFromPicker(`workflow-completed:${completedId}`);
		assert.equal(resumeSpy.mock.calls.length, 2);
		assert.ok(openedRuns.includes(completedId));

		// Flags are rejected on /resume.
		await assert.rejects(provider.resumeFromPicker(`${durableId} --accept-entry-changes`), /does not accept flags/);

		// Unknown run ID throws a meaningful not-found error.
		resumeSpy.mockRestore();
		const missingId = testRunId("missing-run");
		await assert.rejects(provider.resumeFromPicker(missingId), new RegExp(`Workflow run not found: ${missingId}`));

		// Stage-scoped resume on a live paused stage resumes only that stage.
		const liveStageRunId = testRunId("live-stage-resume");
		let resumedStageCalls = 0;
		store.recordRunStart({
			id: liveStageRunId,
			name: sampleDefinition.name,
			status: "paused",
			startedAt: 5_000,
			pausedAt: 6_000,
			inputs: {},
			stages: [
				{
					id: "stage-alpha",
					name: "alpha",
					status: "paused",
					startedAt: 5_000,
					parentIds: [],
					toolEvents: [],
				},
			],
			toolNodes: [],
		});
		stageControlRegistry.register({
			runId: liveStageRunId,
			stageId: "stage-alpha",
			stageName: "alpha",
			status: "paused",
			sessionId: undefined,
			sessionFile: undefined,
			isStreaming: false,
			messages: [],
			ensureAttached: async () => undefined,
			prompt: async () => undefined,
			steer: async () => undefined,
			followUp: async () => undefined,
			pause: async () => undefined,
			resume: async () => {
				resumedStageCalls++;
				return undefined;
			},
			subscribe: () => () => undefined,
		});
		await backend.commitWorkflowRegistration({
			workflowId: liveStageRunId,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 5_000,
			updatedAt: 6_000,
			status: "paused",
			completedCheckpoints: 1,
			invocationCwd: process.cwd(),
		});
		await provider.resumeFromPicker(`${liveStageRunId} alpha`);
		assert.equal(resumedStageCalls, 1);
	});

	test("changed workflow definition shows inline Selector confirmation, resumes on Enter with acceptEntryChanges: true, and cancels on Esc or abort (#5256)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);

		const workDir = makeTempDir("resume-entry-edit-");
		const workerFile = join(workDir, "worker-def.ts");
		writeFileSync(workerFile, "export default { v: 1 };\n");
		const initialDigest = await definitionDigest(workerFile);
		writeFileSync(workerFile, "export default { v: 2 };\n");

		const editedRunId = testRunId("edited-entry-run");
		await backend.commitWorkflowRegistration({
			workflowId: editedRunId,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 1_000,
			updatedAt: 2_000,
			status: "paused",
			completedCheckpoints: 1,
			invocationCwd: workDir,
			resources: {
				definitions: [{ path: workerFile, exportName: "default", digest: initialDigest }],
			},
		});

		const runtime = createExtensionRuntime({ definitions: [sampleDefinition], store });
		const resumeSpy = vi.spyOn(runtime, "resumeDurableWorkflow").mockResolvedValue({
			ok: true,
			runId: editedRunId,
			workflowId: editedRunId,
			name: sampleDefinition.name,
			message: `Resumed ${editedRunId}`,
		});

		let generationCurrent = true;
		const deps: WorkflowRunControlDeps & { context: () => PiCommandContext } = {
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			isGenerationCurrent: () => generationCurrent,
			context: () => ({ hasUI: true, cwd: workDir, ui: { notify: () => undefined } }),
		};
		const provider = createWorkflowResumeProvider(deps);

		// 1. Pressing Esc in the inline Selector cancels without calling resumeDurableWorkflow.
		let renderedLines: string[] = [];
		const escCtx: PiCommandContext = {
			hasUI: true,
			cwd: workDir,
			ui: {
				notify: () => undefined,
				custom: async (factory) => {
					let result: boolean | undefined;
					const component = await factory({} as never, {} as never, new KeybindingsManager() as never, (val) => {
						result = val === true;
					});
					renderedLines = component.render(120).map(stripAnsi);
					component.handleInput?.("\x1b");
					return result;
				},
			},
		};
		await provider.resumeFromPicker(editedRunId, escCtx);
		assert.equal(resumeSpy.mock.calls.length, 0, "Esc must not resume the workflow");
		assert.ok(
			renderedLines.some((line) => line.includes(WORKFLOW_DEFINITION_CHANGED_TITLE)),
			renderedLines.join("\n"),
		);
		assert.equal(renderedLines.at(-1)?.trim(), "enter resume with the new definition · esc cancel");

		// 2. Pressing Enter confirms and calls resumeDurableWorkflow with acceptEntryChanges: true.
		const enterCtx: PiCommandContext = {
			hasUI: true,
			cwd: workDir,
			ui: {
				notify: () => undefined,
				custom: async (factory) => {
					let result: boolean | undefined;
					const component = await factory({} as never, {} as never, new KeybindingsManager() as never, (val) => {
						result = val === true;
					});
					component.handleInput?.("\r");
					return result;
				},
			},
		};
		await provider.resumeFromPicker(editedRunId, enterCtx);
		assert.equal(resumeSpy.mock.calls.length, 1);
		assert.equal(resumeSpy.mock.calls[0]![0], editedRunId);
		assert.equal(resumeSpy.mock.calls[0]![1]?.acceptEntryChanges, true);

		// 3. Stale Enter after session abort or generation retirement never resumes.
		const abortController = new AbortController();
		const abortCtx: PiCommandContext = {
			hasUI: true,
			cwd: workDir,
			sessionSignal: abortController.signal,
			ui: {
				notify: () => undefined,
				custom: async (factory) => {
					let result: boolean | undefined;
					const component = await factory({} as never, {} as never, new KeybindingsManager() as never, (val) => {
						result = val === true;
					});
					abortController.abort();
					component.handleInput?.("\r");
					return result;
				},
			},
		};
		await provider.resumeFromPicker(editedRunId, abortCtx);
		assert.equal(resumeSpy.mock.calls.length, 1, "aborted session signal must block resume");

		generationCurrent = false;
		await provider.resumeFromPicker(editedRunId, enterCtx);
		assert.equal(resumeSpy.mock.calls.length, 1, "retired generation must block resume");
	});

	test("deleteResumeEntry deletes inactive durable runs and refuses active or live-paused runs", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);

		const durableId = testRunId("deletable-durable");
		const activeId = testRunId("undeletable-active");

		await backend.commitWorkflowRegistration({
			workflowId: durableId,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 1_000,
			updatedAt: 2_000,
			status: "paused",
			completedCheckpoints: 1,
			invocationCwd: process.cwd(),
		});
		await backend.commitWorkflowRegistration({
			workflowId: activeId,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 3_000,
			updatedAt: 4_000,
			status: "running",
			completedCheckpoints: 1,
			invocationCwd: process.cwd(),
		});
		store.recordRunStart({
			id: activeId,
			name: sampleDefinition.name,
			status: "running",
			startedAt: 3_000,
			inputs: {},
			stages: [],
			toolNodes: [],
		});

		const runtime = createExtensionRuntime({ definitions: [sampleDefinition], store });
		const provider = createWorkflowResumeProvider({
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			context: () => ({ hasUI: true, cwd: process.cwd(), ui: { notify: () => undefined } }),
		});

		await assert.rejects(provider.deleteResumeEntry(activeId), /running|active|Cannot delete/i);
		assert.ok(backend.getWorkflow(activeId) !== undefined);

		await provider.deleteResumeEntry(`workflow-durable:${durableId}`);
		assert.equal(backend.getWorkflow(durableId), undefined);
	});

	test("lists and adopts an SDK run released by a previous session (#3569, #5256)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);

		const releasedId = testRunId("released-sdk-run");
		await backend.commitWorkflowRegistration({
			workflowId: releasedId,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 1_000,
			updatedAt: 2_000,
			status: "paused",
			completedCheckpoints: 1,
			modelOwner: "previous-session",
			releasedModelOwner: "previous-session",
			origin: "agent",
			invocationCwd: process.cwd(),
		});

		const runtime = createExtensionRuntime({ definitions: [sampleDefinition], store });
		const provider = createWorkflowResumeProvider({
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			context: () => ({
				hasUI: true,
				cwd: process.cwd(),
				ui: { notify: () => undefined },
				sessionManager: { getSessionId: () => "successor-session" } as never,
			}),
		});

		const listed = await provider.listResumeEntries();
		assert.equal(
			listed.some((row) => row.id === releasedId),
			true,
		);
		const targeted = await provider.listResumeEntries(releasedId.slice(0, 8));
		assert.equal(
			targeted.some((row) => row.id === releasedId),
			true,
		);

		await provider.resumeFromPicker(releasedId.slice(0, 8));
		await vi.waitFor(() => assert.equal(backend.getWorkflow(releasedId)?.status, "completed"));
		assert.equal(backend.getWorkflow(releasedId)?.modelOwner, "successor-session");
		assert.equal(backend.getWorkflow(releasedId)?.releasedModelOwner, undefined);
	});
});
