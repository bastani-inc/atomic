import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { SettingsSchema } from "../../packages/coding-agent/src/core/settings-schema.js";
import { JournalCatalogError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	ForkJournalUnavailableError,
	ForkPoolSessionsUnavailableError,
	ForkSessionClaimError,
	ForkSourceBusyError,
	ForkSourceNotFoundError,
	ForkSourceOwnershipError,
} from "../../packages/workflows/src/durable/fork-errors.js";
import {
	crossProjectResumeMessage,
	resumeDurableWorkflow,
} from "../../packages/workflows/src/durable/resume-runtime.js";
import { inspectTargetedDurableWorkflow } from "../../packages/workflows/src/durable/targeted-inspection.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { sessionSwitchQuitConfirmation } from "../../packages/workflows/src/extension/extension-lifecycle.js";
import type { PiCommandContext, PiMessageRenderer } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { handleDurableResume } from "../../packages/workflows/src/extension/workflow-durable-resume-command.js";
import {
	formatWorkflowHeartbeatNoticeText,
	registerWorkflowHeartbeatRenderer,
} from "../../packages/workflows/src/extension/workflow-heartbeat-notice.js";
import {
	DEFAULT_PROMPT_GUIDANCE,
	WORKFLOW_TOOL_DESCRIPTION,
} from "../../packages/workflows/src/extension/workflow-prompts.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { workflowQuitAction } from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import {
	createStageControlRegistry,
	type StageControlHandle,
	stageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { renderInputsSchema } from "../../packages/workflows/src/shared/render-inputs-schema.js";
import { StageRehydrationError, StageWaitError } from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { renderStatusList } from "../../packages/workflows/src/tui/status-list.js";
import { renderWorkflowList } from "../../packages/workflows/src/tui/workflow-list.js";
import { sharedPoolProblems } from "../../packages/workflows/src/workers/placement-errors.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

function makeStageHandle(runId: string, stageId: string): StageControlHandle {
	let status: StageControlHandle["status"] = "running";
	return {
		runId,
		stageId,
		stageName: stageId,
		get status() {
			return status;
		},
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: true,
		messages: [],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		async pause() {
			status = "paused";
		},
		async resume() {
			status = "running";
			return undefined;
		},
		subscribe: () => () => {},
	};
}

function assertNoLegacyWorkflowSlash(text: string, label?: string): void {
	assert.doesNotMatch(text, /\/workflow(?:\s|`|$)/, label);
	assert.doesNotMatch(text, /--accept-entry-changes|--from\b/, label);
}

describe("workflow slash source-copy migration (#5224)", () => {
	test("placement and storage errors guide to /resume and /workflows without /workflow slash commands (#5224)", () => {
		const problem = sharedPoolProblems.poolOnAnotherHost("host-a", "host-b", "run-12345678");
		assertNoLegacyWorkflowSlash(problem.hint ?? "");
		assert.match(problem.hint ?? "", /\/resume/);
		assert.match(problem.hint ?? "", /run-12345678/);

		const shardError = new JournalCatalogError({
			code: "run-not-found",
			catalogPath: "/tmp/catalog.sqlite",
			runId: "run-12345678",
			localOnly: false,
		});
		assertNoLegacyWorkflowSlash(shardError.hint);
		assert.match(shardError.hint, /\/workflows/);
	});

	test("fork errors point to /workflows and /resume without /workflow slash commands or flags (#5224)", () => {
		const runId = "11111111-1111-4111-8111-111111111111";
		const forkRunId = "22222222-2222-4222-8222-222222222222";
		const errors = [
			new ForkSourceBusyError({ runId, reason: "lease-lost" }),
			new ForkSourceBusyError({ runId, reason: "live-execution" }),
			new ForkSourceNotFoundError({
				runId,
				reason: "not-found",
				storage: { adapter: "sqlite", scope: "local-only" },
			}),
			new ForkSourceNotFoundError({ runId, reason: "not-found" }),
			new ForkSourceNotFoundError({ runId, reason: "malformed" }),
			new ForkSourceOwnershipError({ runId, reason: "foreign-owner" }),
			new ForkSourceOwnershipError({ runId, reason: "owner-unavailable" }),
			new ForkJournalUnavailableError(
				{
					runId,
					forkRunId,
					phase: "commit",
					storage: { adapter: "sqlite", scope: "local-only" },
				},
				{ cause: new Error("offline") },
			),
			new ForkJournalUnavailableError(
				{
					runId,
					forkRunId,
					phase: "hydrate",
					storage: { adapter: "sqlite", scope: "local-only" },
				},
				{ cause: new Error("offline") },
			),
			new ForkSessionClaimError({
				reason: "owned-by-other-work",
				sessionId: "s-1",
				rootRunId: runId,
				childRunId: forkRunId,
				scope: "child",
				replayKey: "k",
				stageRunId: runId,
			}),
			new ForkPoolSessionsUnavailableError({ runId, forkRunId, placement: "machine" }),
			new ForkPoolSessionsUnavailableError({ runId, forkRunId, placement: "shared" }),
		];
		for (const err of errors) {
			assertNoLegacyWorkflowSlash(err.hint, err.name);
			assertNoLegacyWorkflowSlash(err.message, err.name);
			assert.match(err.hint, /\/workflows|\/resume/, err.name);
		}
	});

	test("stage wait and rehydration errors guide to /workflows and /resume without /workflow slash commands (#5224)", () => {
		const replayed = new StageWaitError("replayed-stage", { stageName: "build" });
		assertNoLegacyWorkflowSlash(replayed.message);
		assert.match(replayed.message, /\/workflows/);

		const unsaved = new StageRehydrationError(
			{ runId: "run-abc", stageName: "build", sessionId: "s-1", toolCallIds: ["c1"] },
			{ code: "results-not-saved" },
		);
		assertNoLegacyWorkflowSlash(unsaved.message);
		assert.match(unsaved.message, /\/workflows|\/resume/);
	});

	test("heartbeat notices, workflow list, status list, and input schema renderers omit /workflow slash commands (#5224)", () => {
		const runId = "33333333-3333-4333-8333-333333333333";
		const details = {
			runId,
			workflowName: "release-check",
			startedAt: 1_000,
			scheduledAt: 901_000,
			intervalMinutes: 15,
		};
		const hbText = formatWorkflowHeartbeatNoticeText(details);
		assertNoLegacyWorkflowSlash(hbText);
		assert.match(hbText, new RegExp(`/workflows ${runId}`));

		let renderer: PiMessageRenderer | undefined;
		registerWorkflowHeartbeatRenderer({
			rendererHost: {},
			registerMessageRenderer(_type, value) {
				renderer = value;
			},
		});
		const rendered = renderer?.({ details });
		const card = rendered && typeof rendered === "object" ? rendered.render(100).join("\n") : "";
		assertNoLegacyWorkflowSlash(card);
		assert.match(card, new RegExp(`/workflows ${runId}`));

		const listText = renderWorkflowList(
			[{ name: "demo", description: "Demo workflow", inputs: [{ name: "prompt", required: true }] }],
			{ width: 100 },
		);
		assertNoLegacyWorkflowSlash(listText);

		const statusText = renderStatusList(
			[
				{
					id: runId,
					name: "demo",
					inputs: {},
					status: "paused",
					exitReason: "quit",
					resumable: true,
					startedAt: 1_000,
					stages: [],
					toolNodes: [],
				},
			],
			{ width: 100, now: 3_000 },
		);
		assertNoLegacyWorkflowSlash(statusText);
		assert.match(statusText, /\/workflows/);
		assert.match(statusText, /resumable via \/resume/);

		const inputsPretty = renderInputsSchema("demo", [{ name: "prompt", type: "text", required: true }], {
			theme: deriveGraphTheme({}),
		});
		assertNoLegacyWorkflowSlash(inputsPretty);
	});

	test("session switch confirmation, targeted inspection, and cross-project resume messages guide to /resume and /workflows (#5224)", async () => {
		const confirm = sessionSwitchQuitConfirmation("new", 1);
		assertNoLegacyWorkflowSlash(confirm.message);
		assert.match(confirm.message, /\/resume/);

		const crossProject = crossProjectResumeMessage("run-xyz", "/other/project");
		assertNoLegacyWorkflowSlash(crossProject);
		assert.match(crossProject, /\/resume/);

		const store = createStore();
		const runId = "44444444-4444-4444-8444-444444444444";
		store.recordRunStart({
			id: runId,
			name: "demo",
			inputs: {},
			status: "running",
			startedAt: 1_000,
			stages: [],
			toolNodes: [],
		});
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: "demo",
			inputs: {},
			createdAt: 1_000,
			updatedAt: 2_000,
			status: "running",
			completedCheckpoints: 1,
			invocationCwd: process.cwd(),
		});
		const alreadyRunning = await resumeDurableWorkflow(runId, {
			registry: createRegistry(),
			durableBackend: backend,
			baseRunOpts: { cwd: process.cwd(), store },
			resolveDefinition: async () => undefined,
		});
		assert.equal(alreadyRunning.ok, false);
		if (!alreadyRunning.ok) {
			assertNoLegacyWorkflowSlash(alreadyRunning.message);
			assert.match(alreadyRunning.message, new RegExp(`/workflows ${runId}`));
		}

		store.removeRun(runId);
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: "stage-1",
			name: "draft",
			replayKey: "workflow:demo:1:stage:draft:1",
			completedAt: 2_000,
			topology: {
				version: 1,
				stageId: "draft",
				parentIds: [],
				sourceOrder: 0,
				status: "completed",
				run: { runId, runName: "demo" },
			},
		});
		await backend.commitWorkflowStatus(runId, "paused");
		const inspected = await inspectTargetedDurableWorkflow(backend, runId);
		assert.equal(inspected.kind, "found");
		if (inspected.kind === "found") {
			assertNoLegacyWorkflowSlash(inspected.detail.resumeGuidance ?? "");
			assert.match(inspected.detail.resumeGuidance ?? "", /\/resume/);
		}
	});

	test("background status, pause, and quit messages guide to /workflows and /resume without /workflow slash commands (#5224)", async () => {
		const store = createStore();
		const failedId = "55555555-5555-4555-8555-555555555555";
		store.recordRunStart({
			id: failedId,
			name: "demo",
			inputs: {},
			status: "failed",
			exited: true,
			resumable: true,
			startedAt: 1_000,
			endedAt: 2_000,
			stages: [],
			toolNodes: [],
		});
		const resumedFailed = await resumeRun(failedId, { store });
		assert.equal(resumedFailed.ok, true);
		if (resumedFailed.ok) {
			assertNoLegacyWorkflowSlash(resumedFailed.message ?? "");
			assert.match(resumedFailed.message ?? "", /\/workflows|\/resume/);
		}

		const runningId = "66666666-6666-4666-8666-666666666666";
		store.recordRunStart({
			id: runningId,
			name: "demo",
			inputs: {},
			status: "running",
			startedAt: 1_000,
			stages: [],
			toolNodes: [],
		});
		const toolControlRegistry = createToolControlRegistry();
		const progress = { completedCheckpoints: 0, pendingPrompts: 0 };
		toolControlRegistry.registerRun(runningId, {
			paused: false,
			durableBackend: {
				getWorkflow: (id: string) => (id === runningId ? { workflowId: runningId, ...progress } : undefined),
			} as never,
			async pause() {},
			async resume() {},
			async quit() {},
		});
		const pauseOpts = { store, toolControlRegistry, stageControlRegistry: createStageControlRegistry() };
		const pausedLocal = await pauseRun(runningId, pauseOpts);
		assert.equal(pausedLocal.ok, true);
		if (pausedLocal.ok) {
			assertNoLegacyWorkflowSlash(pausedLocal.message ?? "");
			assert.match(pausedLocal.message ?? "", /\/workflows/);
		}
		store.recordRunResumed(runningId);
		progress.completedCheckpoints = 2;
		const pausedDurable = await pauseRun(runningId, pauseOpts);
		assert.equal(pausedDurable.ok, true);
		if (pausedDurable.ok) {
			assertNoLegacyWorkflowSlash(pausedDurable.message ?? "");
			assert.match(pausedDurable.message ?? "", /\/workflows/);
			assert.match(pausedDurable.message ?? "", /\/resume/);
		}

		const quitId = "77777777-7777-4777-8777-777777777777";
		store.recordRunStart({
			id: quitId,
			name: "demo",
			inputs: {},
			status: "running",
			startedAt: 1_000,
			stages: [{ id: "s1", name: "s1", status: "running", startedAt: 1_000, parentIds: [], toolEvents: [] }],
			toolNodes: [],
		});
		const unregQuit = stageControlRegistry.register(makeStageHandle(quitId, "s1"));
		try {
			const quitRes = await quitRun(quitId, { store });
			assert.equal(quitRes.ok, true);
			if (quitRes.ok) {
				assertNoLegacyWorkflowSlash(quitRes.message ?? "");
			}
		} finally {
			unregQuit();
		}

		const quitToolId = "88888888-8888-4888-8888-888888888888";
		store.recordRunStart({
			id: quitToolId,
			name: "demo",
			inputs: {},
			status: "running",
			startedAt: 1_000,
			stages: [{ id: "s1", name: "s1", status: "running", startedAt: 1_000, parentIds: [], toolEvents: [] }],
			toolNodes: [],
		});
		const unregToolQuit = stageControlRegistry.register(makeStageHandle(quitToolId, "s1"));
		try {
			const toolQuit = await workflowQuitAction(
				{ runId: quitToolId },
				{
					store,
					stageControlRegistry,
					toolControlRegistry,
					stageUiBroker: {} as never,
					jobs: {} as never,
				},
			);
			const quitMessage = "message" in toolQuit && typeof toolQuit.message === "string" ? toolQuit.message : "";
			assertNoLegacyWorkflowSlash(quitMessage);
			assert.match(quitMessage, /\/workflows|\/resume/);
		} finally {
			unregToolQuit();
		}
	});

	test("durable resume and run-control helpers omit /workflow slash commands (#5224)", async () => {
		const store = createStore();
		const def = workflow({
			name: "demo",
			description: "demo",
			inputs: {},
			outputs: {},
			run: async () => ({}),
		});
		const runtime = createExtensionRuntime({ definitions: [def], store });
		const ctx: PiCommandContext = { hasUI: false, cwd: process.cwd(), ui: { notify: () => undefined } };
		const infos: string[] = [];
		const errors: string[] = [];
		const reporter = {
			info: (msg: string) => infos.push(msg),
			error: (msg: string) => errors.push(msg),
		};
		const deps = {
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			owner: { store, toolControls: { runControl: () => undefined }, cancellations: { cancel: () => undefined } },
		};
		await handleDurableResume(undefined, ctx, reporter, deps as never, { resumable: [], completed: [] });
		assert.equal(errors.length, 1);
		assertNoLegacyWorkflowSlash(errors[0]!);
		assert.match(errors[0]!, /\/resume/);

		const runId = "99999999-9999-4999-8999-999999999999";
		await handleDurableResume(undefined, ctx, reporter, deps as never, {
			resumable: [
				{
					workflowId: runId,
					name: "demo",
					status: "paused",
					createdAt: 1_000,
					updatedAt: 2_000,
					completedCheckpoints: 1,
					pendingPrompts: 0,
				},
			],
			completed: [],
		});
		assert.equal(infos.length, 1);
		assertNoLegacyWorkflowSlash(infos[0]!);
		assert.match(infos[0]!, /\/resume/);

		store.recordRunStart({
			id: runId,
			name: "demo",
			inputs: {},
			status: "running",
			startedAt: 1_000,
			stages: [{ id: "s1", name: "s1", status: "running", startedAt: 1_000, parentIds: [], toolEvents: [] }],
			toolNodes: [],
		});
		const unreg = stageControlRegistry.register(makeStageHandle(runId, "s1"));
		try {
			infos.length = 0;
			await handleRunControlCommand("pause", [runId, "s1", "--yes"], ctx, reporter, {
				...deps,
				owner: {
					store,
					stageControls: stageControlRegistry,
					toolControls: createToolControlRegistry(),
					cancellations: { cancel: () => undefined },
				},
			} as never);
			assert.equal(infos.length, 1);
			assertNoLegacyWorkflowSlash(infos[0]!);
			assert.match(infos[0]!, /\/workflows/);
		} finally {
			unreg();
		}
	});

	test("workflow tool prompt and settings schema omit /workflow slash command references (#5224)", () => {
		assertNoLegacyWorkflowSlash(WORKFLOW_TOOL_DESCRIPTION);
		for (const section of DEFAULT_PROMPT_GUIDANCE) {
			assertNoLegacyWorkflowSlash(section);
		}
		assertNoLegacyWorkflowSlash(JSON.stringify(SettingsSchema));
	});
});
