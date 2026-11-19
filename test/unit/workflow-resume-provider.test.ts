import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, stripHintMarkers } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, describe, onTestFinished, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import {
	initTheme,
	refreshColorEnvironment,
	theme,
} from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { PiCommandContext } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	WORKFLOW_DEFINITION_CHANGED_INLINE_PROMPT,
	WORKFLOW_DEFINITION_CHANGED_TITLE,
	type WorkflowRunControlDeps,
} from "../../packages/workflows/src/extension/workflow-durable-resume-command.js";
import { createWorkflowResumeProvider } from "../../packages/workflows/src/extension/workflow-resume-provider.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest } from "../../packages/workflows/src/workers/definitions.js";
import { refusedResourceChanges } from "../../packages/workflows/src/workers/public-pool.js";
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

	test("resource refresh warnings appear once while catalog polls keep retrying (#5256)", async () => {
		const runtime = createExtensionRuntime({ definitions: [sampleDefinition], store });
		const notifications: string[] = [];
		const ensure = vi.fn(() => {
			throw new Error("Unavailable workflow directory");
		});
		const provider = createWorkflowResumeProvider({
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: ensure,
			context: () => ({ hasUI: true, cwd: process.cwd(), ui: { notify: (message) => notifications.push(message) } }),
		});
		await provider.listResumeEntries();
		await provider.listResumeEntries();
		await provider.listResumeEntries();
		assert.equal(ensure.mock.calls.length, 3);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!, /`\/reload`/);
		assert.doesNotMatch(notifications[0]!, /\/workflow\s/);
	});

	test("resume errors point to current run actions without obsolete flags or circular mixed-refusal guidance (#5224, #5256)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		const id = testRunId("picker-guidance");
		await backend.commitWorkflowRegistration({
			workflowId: id,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 1_000,
			updatedAt: 2_000,
			status: "paused",
			completedCheckpoints: 1,
			invocationCwd: process.cwd(),
		});
		const runtime = createExtensionRuntime({ definitions: [sampleDefinition], store });
		const resume = vi.spyOn(runtime, "resumeDurableWorkflow");
		const provider = createWorkflowResumeProvider({
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			context: () => ({ hasUI: true, cwd: process.cwd(), ui: { notify: () => undefined } }),
		});
		for (const [command, expected] of [
			[`/workflow fork ${id} --from review`, /\/workflows/],
			[`/workflow quit ${id}`, /\/workflows/],
			[`/workflow status ${id}`, /\/workflows/],
			["/workflow reload", /\/reload/],
			[`/workflow resume ${id} --accept-entry-changes to continue`, /\/resume/],
		] as const) {
			resume.mockResolvedValue({ ok: false, reason: "not_resumable", message: `Use ${command}.` });
			await assert.rejects(provider.resumeFromPicker(id), (error: Error) => {
				assert.match(error.message, expected);
				assert.doesNotMatch(error.message, /\/workflow\s|--accept-entry-changes| {2}/);
				return true;
			});
		}

		const saved = {
			definitions: [{ path: "/w/a.ts", exportName: "default", digest: "a".repeat(64) }],
			localWorkers: { count: 2, definitions: [] },
		};
		const current = {
			...saved,
			definitions: [{ path: "/w/a.ts", exportName: "default", digest: "b".repeat(64) }],
			admission: { limits: { user: 3 } },
		};
		const mixedMessage =
			`Since root ${id} started, ${refusedResourceChanges(saved as never, current as never, undefined)
				.map((change) => change.description)
				.join("; ")}.` +
			` Its recorded steps and queued children depend on these, so restore them to resume it, or start a new run. The pool size (localWorkers.count) and the root's own limits (admission.limits and admission.host) can change between resumes. An edited entry module can also be accepted: resume with /workflow resume ${id} --accept-entry-changes, or acceptEntryChanges: true in the SDK, to replay the recorded steps and run the rest of each unfinished child with the edited module.`;
		resume.mockResolvedValue({ ok: false, reason: "startup_failed", message: mixedMessage });
		await assert.rejects(provider.resumeFromPicker(id), (error: Error) => {
			assert.doesNotMatch(
				error.message,
				/\/resume\s+\S+,? or acceptEntryChanges|can also be accepted: resume with \/resume/,
			);
			assert.doesNotMatch(error.message, /\/workflow(?!s)\b|\s{2,}/);
			return true;
		});
	});

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

	test("completed-only catalogs stay out of the picker but remain inspectable by direct id (#5256)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		const id = testRunId("completed-only-direct");
		await backend.commitWorkflowRegistration({
			workflowId: id,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 1_000,
			updatedAt: 2_000,
			status: "completed",
			completedCheckpoints: 1,
			invocationCwd: process.cwd(),
		});
		await backend.commitCheckpoint({
			topology: { version: 1, nodeId: "tool:done-hash", ordinal: 1, order: 1, parentIds: [] },
			kind: "tool",
			workflowId: id,
			checkpointId: "tool:done",
			name: "done",
			argsHash: "done-hash",
			output: true,
			completedAt: 2_000,
		});
		const runtime = createExtensionRuntime({ definitions: [sampleDefinition], store });
		const opened: string[] = [];
		const provider = createWorkflowResumeProvider({
			pi: {},
			overlay: {
				open: (runId) => {
					if (runId) opened.push(runId);
				},
				toggle: () => undefined,
				close: () => undefined,
			},
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			context: () => ({ hasUI: true, cwd: process.cwd(), ui: { notify: () => undefined } }),
		});
		assert.deepEqual(await provider.listResumeEntries(), []);
		assert.deepEqual(
			(await provider.listResumeEntries(id.slice(0, 8))).map((row) => row.id),
			[id],
		);
		await provider.resumeFromPicker(id);
		assert.deepEqual(opened, [id]);
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

		const defaultRows = await provider.listResumeEntries();
		assert.equal(
			defaultRows.some((row) => row.id === crossProjectId),
			false,
		);

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

		await provider.resumeFromPicker(`workflow-completed:${completedId}`);
		assert.equal(resumeSpy.mock.calls.length, 2);
		assert.ok(openedRuns.includes(completedId));

		await assert.rejects(provider.resumeFromPicker(`${durableId} --accept-entry-changes`), /does not accept flags/);

		resumeSpy.mockRestore();
		const missingId = testRunId("missing-run");
		await assert.rejects(provider.resumeFromPicker(missingId), new RegExp(`Workflow run not found: ${missingId}`));

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

	test("changed workflow definition shows inline confirmation without host paths or digests, resumes on Enter with acceptEntryChanges: true, and cancels on Esc or abort (#5224, #5256)", async () => {
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

		let renderedLines: string[] = [];
		let narrowLines: string[] = [];
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
					narrowLines = component.render(80).map(stripAnsi);
					component.handleInput?.("\x1b");
					return result;
				},
			},
		};
		await provider.resumeFromPicker(editedRunId, escCtx);
		assert.equal(resumeSpy.mock.calls.length, 0, "Esc must not resume the workflow");
		assert.deepEqual(
			renderedLines.map((line) => line.trim()),
			[WORKFLOW_DEFINITION_CHANGED_INLINE_PROMPT],
		);
		assert.doesNotMatch(renderedLines.join("\n"), /Since root|sha256|worker-def\.ts/);
		assert.ok(narrowLines.every((line) => line.length <= 80));
		assert.equal(narrowLines.map((line) => line.trim()).join(" "), WORKFLOW_DEFINITION_CHANGED_INLINE_PROMPT);

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

	test("the changed-definition prompt answers only the keys its line names, in the themed line and the confirm fallback (#5256)", async () => {
		vi.stubEnv("NO_COLOR", undefined);
		refreshColorEnvironment();
		onTestFinished(() => {
			vi.unstubAllEnvs();
			refreshColorEnvironment();
		});
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		const workDir = makeTempDir("resume-entry-keys-");
		const workerFile = join(workDir, "worker-def.ts");
		writeFileSync(workerFile, "export default { v: 1 };\n");
		const initialDigest = await definitionDigest(workerFile);
		writeFileSync(workerFile, "export default { v: 2 };\n");
		const editedRunId = testRunId("edited-entry-keys");
		await backend.commitWorkflowRegistration({
			workflowId: editedRunId,
			name: sampleDefinition.name,
			inputs: {},
			createdAt: 1_000,
			updatedAt: 2_000,
			status: "paused",
			completedCheckpoints: 1,
			invocationCwd: workDir,
			resources: { definitions: [{ path: workerFile, exportName: "default", digest: initialDigest }] },
		});
		const runtime = createExtensionRuntime({ definitions: [sampleDefinition], store });
		const resumeSpy = vi.spyOn(runtime, "resumeDurableWorkflow").mockResolvedValue({
			ok: true,
			runId: editedRunId,
			workflowId: editedRunId,
			name: sampleDefinition.name,
			message: `Resumed ${editedRunId}`,
		});
		const provider = createWorkflowResumeProvider({
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			context: () => ({ hasUI: true, cwd: workDir, ui: { notify: () => undefined } }),
		});

		let themedLines: string[] = [];
		let unsettledAfterArrows = false;
		const keysCtx: PiCommandContext = {
			hasUI: true,
			cwd: workDir,
			ui: {
				notify: () => undefined,
				custom: async (factory) => {
					let result: boolean | undefined;
					const component = await factory(
						{} as never,
						theme as never,
						new KeybindingsManager() as never,
						(val) => {
							result = val === true;
						},
					);
					themedLines = component.render(160);
					for (const key of ["\x1b[C", "\x1b[D", "\x1b[A", "\x1b[B", " ", "?"]) component.handleInput?.(key);
					unsettledAfterArrows = result === undefined;
					component.handleInput?.("\x1b");
					return result;
				},
			},
		};
		await provider.resumeFromPicker(editedRunId, keysCtx);
		assert.equal(unsettledAfterArrows, true, "keys the line does not name leave the prompt open");
		assert.equal(resumeSpy.mock.calls.length, 0, "only Enter accepts the changed definition");
		assert.deepEqual(
			themedLines.map((line) => stripAnsi(line).trim()),
			[WORKFLOW_DEFINITION_CHANGED_INLINE_PROMPT],
		);
		assert.match(WORKFLOW_DEFINITION_CHANGED_INLINE_PROMPT, / · enter .+ · esc .+$/);
		assert.ok(themedLines[0]!.includes(theme.fg("warning", WORKFLOW_DEFINITION_CHANGED_TITLE)), "themed title");

		const remapped = new KeybindingsManager({
			"tui.select.confirm": ["right", "enter"],
			"tui.select.cancel": ["q"],
			"app.list.open": ["left"],
		});
		const remappedRuns: Array<Array<boolean | undefined>> = [];
		for (const keys of [["\x1b[C", "\x1b[D", "q", "\r"], ["\x1b"], ["\x03"]]) {
			const remappedCtx: PiCommandContext = {
				hasUI: true,
				cwd: workDir,
				ui: {
					notify: () => undefined,
					custom: async (factory) => {
						let result: boolean | undefined;
						const component = await factory({} as never, theme as never, remapped as never, (val) => {
							result = val === true;
						});
						const afterEachKey: Array<boolean | undefined> = [];
						for (const key of keys) {
							if (result === undefined) component.handleInput?.(key);
							afterEachKey.push(result);
						}
						remappedRuns.push(afterEachKey);
						if (result === undefined) component.handleInput?.("\x1b");
						return result;
					},
				},
			};
			await provider.resumeFromPicker(editedRunId, remappedCtx);
		}
		assert.deepEqual(
			remappedRuns,
			[[undefined, undefined, undefined, true], [false], [false]],
			"only Enter accepts and Esc or Ctrl+C cancels, whatever the confirm and cancel bindings are",
		);
		assert.equal(resumeSpy.mock.calls.length, 1);
		resumeSpy.mockClear();

		vi.stubEnv("NO_COLOR", "1");
		refreshColorEnvironment();
		try {
			let plainLines: string[] = [];
			const noColorCtx: PiCommandContext = {
				hasUI: true,
				cwd: workDir,
				ui: {
					notify: () => undefined,
					custom: async (factory) => {
						const component = await factory(
							{} as never,
							theme as never,
							new KeybindingsManager() as never,
							() => {},
						);
						plainLines = component.render(160).map(stripHintMarkers);
						component.handleInput?.("\x1b");
						return false;
					},
				},
			};
			await provider.resumeFromPicker(editedRunId, noColorCtx);
			assert.deepEqual(plainLines, [`  ${WORKFLOW_DEFINITION_CHANGED_INLINE_PROMPT}`], "NO_COLOR prompt");
		} finally {
			vi.stubEnv("NO_COLOR", undefined);
			refreshColorEnvironment();
		}

		const confirmCalls: string[][] = [];
		const confirmCtx: PiCommandContext = {
			hasUI: true,
			cwd: workDir,
			ui: {
				notify: () => undefined,
				confirm: async (title: string, message: string) => {
					confirmCalls.push([title, message]);
					return false;
				},
			},
		};
		await provider.resumeFromPicker(editedRunId, confirmCtx);
		assert.equal(confirmCalls.length, 1);
		assert.equal(confirmCalls[0]![1], WORKFLOW_DEFINITION_CHANGED_INLINE_PROMPT);
		assert.equal(resumeSpy.mock.calls.length, 0);
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
