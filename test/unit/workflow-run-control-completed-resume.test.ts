import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	seedWorkflowLifecycleNotificationState,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createExtensionRuntime, type ExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	prepareWorkflowResumeCatalog,
	resolveWorkflowResumeTarget,
	type WorkflowRunControlDeps,
} from "../../packages/workflows/src/extension/workflow-durable-resume-command.js";
import { collectResumePickerLiveRuns } from "../../packages/workflows/src/extension/workflow-resume-picker-rows.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../../packages/workflows/src/shared/workflow-artifacts.js";
import { testRunId } from "../helpers/run-id.js";

let tempDir = "";

beforeEach(() => {
	// The workflows store is a module-level singleton shared across test files in
	// the same bun process; clear leftovers so index/id lookups see only this file's runs.
	store.clear();
	tempDir = mkdtempSync(join(tmpdir(), "atomic-completed-command-"));
});
afterEach(() => {
	setDurableBackend(undefined);
	store.clear();
	rmSync(tempDir, { recursive: true, force: true });
});

function retainedSession(name: string): string {
	const path = join(tempDir, `${name}.jsonl`);
	writeFileSync(
		path,
		`${[
			JSON.stringify({
				type: "session",
				version: 3,
				id: `${name}-session`,
				timestamp: new Date().toISOString(),
				cwd: tempDir,
			}),
			JSON.stringify({
				type: "message",
				id: `${name}-message`,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: `Prior context for ${name}`, timestamp: Date.now() },
			}),
		].join("\n")}\n`,
	);
	return path;
}

function registerCompleted(backend: InMemoryDurableBackend, id: string, sessionFile = retainedSession(id)): void {
	backend.registerWorkflow({ workflowId: id, name: `${id}-flow`, inputs: {}, createdAt: 1, status: "completed" });
	backend.recordCheckpoint({
		kind: "stage",
		workflowId: id,
		checkpointId: "stage:1",
		name: "final",
		replayKey: "stage:final:1",
		output: "ok",
		sessionFile,
		completedAt: 2,
	});
}

function registerCompletedTool(backend: InMemoryDurableBackend, id: string): void {
	backend.registerWorkflow({ workflowId: id, name: `${id}-flow`, inputs: {}, createdAt: 1, status: "completed" });
	backend.recordCheckpoint({
		kind: "tool",
		workflowId: id,
		checkpointId: "tool:done",
		name: "done",
		argsHash: "done-hash",
		output: true,
		completedAt: 2,
	});
}

function commandDeps(runtime: ExtensionRuntime, opened: string[]): WorkflowRunControlDeps {
	return {
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
	};
}

async function resume(
	target: string,
	runtime: ExtensionRuntime,
	opened: string[] = [],
): Promise<{ messages: string[]; errors: string[] }> {
	const messages: string[] = [];
	const errors: string[] = [];
	await handleRunControlCommand(
		"resume",
		[target],
		{ hasUI: true, ui: { notify: () => undefined } },
		{ info: (message) => messages.push(message), error: (message) => errors.push(message) },
		commandDeps(runtime, opened),
	);
	return { messages, errors };
}

describe("/workflow resume completed target", () => {
	test("opens an exact completed id without invoking durable resume dispatch", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		registerCompleted(backend, testRunId("completed-command-target"));
		const baseRuntime = createExtensionRuntime({ store });
		let resumeCalls = 0;
		const runtime: ExtensionRuntime = {
			...baseRuntime,
			resumeDurableWorkflow(workflowIdOrPrefix, options) {
				resumeCalls += 1;
				return baseRuntime.resumeDurableWorkflow(workflowIdOrPrefix, options);
			},
		};
		const opened: string[] = [];

		const result = await resume(testRunId("completed-command-target"), runtime, opened);

		assert.equal(resumeCalls, 0);
		assert.deepEqual(opened, [testRunId("completed-command-target")]);
		assert.match(result.messages.join("\n"), /read-only inspection and follow-up chat/);
		assert.equal(store.runs().find((run) => run.id === testRunId("completed-command-target"))?.status, "completed");
		assert.equal(backend.getWorkflow(testRunId("completed-command-target"))?.status, "completed");
	});

	test("keeps the direct completed fallback lifecycle-silent when the runtime omits the open adapter", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		registerCompletedTool(backend, testRunId("completed-direct-fallback"));
		const lifecycleState = createWorkflowLifecycleNotificationState();
		const sends: Array<{ options: object | undefined }> = [];
		const unsubscribe = installWorkflowLifecycleNotifications({
			store,
			state: lifecycleState,
			seedExisting: false,
			config: { enabled: true, notifyOn: ["completed"] },
			sendMessage(_message, options) {
				sends.push({ options });
			},
		});
		const runtime = { ...createExtensionRuntime({ store }) };
		delete runtime.openCompletedDurableWorkflow;
		const opened: string[] = [];
		const restored: string[][] = [];
		const deps = commandDeps(runtime, opened);
		deps.beforeRestoreCompleted = (snapshots) => {
			assert.equal(
				store.runs().some((run) => run.id === testRunId("completed-direct-fallback")),
				false,
				"lifecycle state must be seeded before the historical snapshot is inserted",
			);
			restored.push(snapshots.map((snapshot) => snapshot.id));
			seedWorkflowLifecycleNotificationState(lifecycleState, { ...store.snapshot(), runs: snapshots });
		};

		try {
			const messages: string[] = [];
			const errors: string[] = [];
			await handleRunControlCommand(
				"resume",
				[testRunId("completed-direct-fallback")],
				{ hasUI: true, ui: { notify: () => undefined } },
				{ info: (message) => messages.push(message), error: (message) => errors.push(message) },
				deps,
			);

			assert.deepEqual(errors, []);
			assert.deepEqual(opened, [testRunId("completed-direct-fallback")]);
			assert.deepEqual(restored, [[testRunId("completed-direct-fallback")]]);
			assert.match(messages.join("\n"), /read-only inspection/);
			assert.equal(
				store.runs().find((run) => run.id === testRunId("completed-direct-fallback"))?.toolNodes?.[0]?.name,
				"done",
			);
			assert.deepEqual(sends, [], "historical command fallback must emit no lifecycle steer/card");
		} finally {
			unsubscribe();
		}
	});

	test("opens an exact completed id and rejects a completed-id prefix", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		registerCompleted(backend, testRunId("completed-exact-alpha"));
		registerCompleted(backend, testRunId("completed-exact-beta"));
		const runtime = createExtensionRuntime({ store });
		const opened: string[] = [];

		const exact = await resume(testRunId("completed-exact-alpha"), runtime, opened);
		store.clear();
		const malformed = await resume("completed-exact-", runtime);

		assert.deepEqual(opened, [testRunId("completed-exact-alpha")]);
		assert.match(exact.messages.join("\n"), /Opened completed durable workflow/);
		assert.match(malformed.errors.join("\n"), /Run id must be a full 36-character UUID/);
	});

	test("reports a clear missing target without dispatching completed inspection", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		registerCompleted(backend, testRunId("known-completed"));

		const missingTarget = testRunId("missing-workflow");
		const result = await resume(missingTarget, createExtensionRuntime({ store }));

		assert.match(result.errors.join("\n"), new RegExp(`No resumable workflow found for id: ${missingTarget}`));
	});

	test("explicit resume of a non-resumable run keeps the explanatory error", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const runId = testRunId("zero-progress-explicit");
		backend.registerWorkflow({
			workflowId: runId,
			name: "zero-progress-flow",
			inputs: {},
			createdAt: 1,
			status: "paused",
			resumable: true,
		});
		store.recordRunStart({
			id: runId,
			name: "zero-progress-flow",
			inputs: {},
			status: "paused",
			stages: [],
			startedAt: 1,
			resumable: true,
		});

		const result = await resume(runId, createExtensionRuntime({ store }));

		assert.match(
			result.errors.join("\n"),
			/has no durable checkpoint or pending prompt progress and is not resumable/,
		);
	});

	test("reports a stale completed target instead of dispatching it", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		backend.registerWorkflow({
			workflowId: testRunId("stale-completed-target"),
			name: "completed-flow",
			inputs: {},
			createdAt: 1,
			status: "completed",
			completedCheckpoints: 1,
		});
		const baseRuntime = createExtensionRuntime({ store });
		let resumeCalls = 0;
		const runtime: ExtensionRuntime = {
			...baseRuntime,
			resumeDurableWorkflow(workflowIdOrPrefix, options) {
				resumeCalls += 1;
				return baseRuntime.resumeDurableWorkflow(workflowIdOrPrefix, options);
			},
		};

		const result = await resume(testRunId("stale-completed-target"), runtime);

		assert.equal(resumeCalls, 0);
		assert.match(result.errors.join("\n"), /stale or missing durable checkpoint\/session data/);
	});

	test("does not let a retained completed snapshot bypass authoritative stale checks", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		backend.registerWorkflow({
			workflowId: testRunId("retained-stale"),
			name: "completed-flow",
			inputs: {},
			createdAt: 1,
			status: "completed",
			completedCheckpoints: 1,
		});
		store.recordRunStart({
			id: testRunId("retained-stale"),
			name: "completed-flow",
			inputs: {},
			status: "completed",
			stages: [],
			startedAt: 1,
			endedAt: 2,
			resumable: false,
		});
		const baseRuntime = createExtensionRuntime({ store });
		let resumeCalls = 0;
		const runtime: ExtensionRuntime = {
			...baseRuntime,
			resumeDurableWorkflow(target, options) {
				resumeCalls += 1;
				return baseRuntime.resumeDurableWorkflow(target, options);
			},
		};
		const opened: string[] = [];

		const result = await resume(testRunId("retained-stale"), runtime, opened);

		assert.equal(resumeCalls, 0);
		assert.deepEqual(opened, []);
		assert.match(result.errors.join("\n"), /stale or missing durable checkpoint\/session data/);
	});

	test("rejects a shared run-id prefix across live and completed workflows", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		registerCompleted(backend, testRunId("shared-completed"));
		store.recordRunStart({
			id: testRunId("shared-live"),
			name: "live-flow",
			inputs: {},
			status: "paused",
			stages: [],
			startedAt: 1,
			resumable: true,
		});
		const result = await resume("shared-", createExtensionRuntime({ store }));

		assert.match(result.errors.join("\n"), /Run id must be a full 36-character UUID/);
	});

	test("excludes cancelled, killed, and non-resumable failed locals from exact-id resolution", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		registerCompleted(backend, testRunId("excluded-completed"));
		store.recordRunStart({
			id: testRunId("excluded-cancelled"),
			name: "cancelled",
			inputs: {},
			status: "cancelled",
			stages: [],
			startedAt: 1,
			endedAt: 2,
			resumable: false,
		});
		store.recordRunStart({
			id: testRunId("excluded-killed"),
			name: "killed",
			inputs: {},
			status: "killed",
			stages: [],
			startedAt: 1,
			endedAt: 2,
			resumable: false,
		});
		store.recordRunStart({
			id: testRunId("excluded-failed"),
			name: "failed",
			inputs: {},
			status: "failed",
			stages: [],
			startedAt: 1,
			endedAt: 2,
			resumable: false,
		});
		const opened: string[] = [];

		const result = await resume(testRunId("excluded-completed"), createExtensionRuntime({ store }), opened);

		assert.equal(result.errors.length, 0);
		assert.deepEqual(opened, [testRunId("excluded-completed")]);
	});

	test("keeps quit shadows on the durable resume path", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		backend.registerWorkflow({
			workflowId: testRunId("quit-shadow"),
			name: "quit-flow",
			inputs: {},
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 1,
		});
		store.recordRunStart({
			id: testRunId("quit-shadow"),
			name: "quit-flow",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
			endedAt: 2,
			exitReason: "quit",
			resumable: true,
		});
		const baseRuntime = createExtensionRuntime({ store });
		let durableResumeCalls = 0;
		const runtime: ExtensionRuntime = {
			...baseRuntime,
			resumeDurableWorkflow() {
				durableResumeCalls += 1;
				return Promise.resolve({
					ok: true,
					runId: testRunId("quit-shadow"),
					workflowId: testRunId("quit-shadow"),
					name: "quit-flow",
					message: "resumed quit shadow",
				});
			},
		};

		const result = await resume(testRunId("quit-shadow"), runtime);

		assert.equal(durableResumeCalls, 1);
		assert.match(result.messages.join("\n"), /resumed quit shadow/);
	});

	for (const status of ["running", "failed", "blocked"] as const) {
		test(`keeps durable ${status} targets on the durable resume path`, async () => {
			const backend = new InMemoryDurableBackend();
			setDurableBackend(backend);
			const id = testRunId(`durable-${status}`);
			const entry = {
				workflowId: id,
				name: `${status}-flow`,
				status,
				completedCheckpoints: 1,
				pendingPrompts: 0,
				createdAt: 1,
				updatedAt: 2,
				resumable: true,
			};
			let resumeCalls = 0;
			const runtime = {
				registry: { has: () => true },
				prepareDurableResumable: async () => [entry],
				prepareCompletedDurable: async () => [],
				resumeDurableWorkflow: () => {
					resumeCalls += 1;
					return { ok: true as const, runId: id, workflowId: id, name: entry.name, message: `resumed ${status}` };
				},
			} as unknown as ExtensionRuntime;

			const result = await resume(id, runtime);

			assert.equal(resumeCalls, 1);
			assert.match(result.messages.join("\n"), new RegExp(`resumed ${status}`));
		});
	}

	test("routes checkpointed resumable failures through durable resume instead of completed inspection", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const id = testRunId("failed-resumable-command-target");
		backend.registerWorkflow({
			workflowId: id,
			name: "failed-resumable-flow",
			inputs: {},
			createdAt: 1,
			status: "failed",
			resumable: true,
			error: "durable tool failed",
		});
		backend.recordCheckpoint({
			kind: "tool",
			workflowId: id,
			checkpointId: "tool-failure:1",
			name: "failed-tool",
			argsHash: "failed-tool-hash",
			output: null,
			throwingFailureError: "durable tool failed",
			completedAt: 2,
		});
		const resumableRow = backend.listResumableWorkflows()[0]!;
		const completedCollision = { ...resumableRow, resumable: false };
		let resumeCalls = 0;
		let completedOpenCalls = 0;
		const runtime = {
			registry: { has: () => true },
			prepareDurableResumable: async () => [resumableRow],
			prepareCompletedDurable: async () => [completedCollision],
			resumeDurableWorkflow() {
				resumeCalls += 1;
				return Promise.resolve({
					ok: true as const,
					runId: id,
					workflowId: id,
					name: "failed-resumable-flow",
					message: "resumed failed durable run",
				});
			},
			openCompletedDurableWorkflow() {
				completedOpenCalls += 1;
				return { ok: false as const, reason: "not_found" as const, message: "must not open completed history" };
			},
		} as unknown as ExtensionRuntime;

		const catalog = await prepareWorkflowResumeCatalog(runtime, new Set(), id);
		assert.deepEqual(
			catalog.resumable.map((entry) => entry.workflowId),
			[id],
		);
		assert.deepEqual(
			catalog.completed.map((entry) => entry.workflowId),
			[id],
			"the collision must exist in both catalogs",
		);
		assert.equal(resolveWorkflowResumeTarget(id, [], catalog.resumable, catalog.completed).kind, "durable");
		assert.equal(
			resolveWorkflowResumeTarget("failed-resumable-command", [], catalog.resumable, catalog.completed).kind,
			"malformed",
		);

		const result = await resume(testRunId("failed-resumable-command-target"), runtime);

		assert.equal(resumeCalls, 1);
		assert.equal(completedOpenCalls, 0);
		assert.deepEqual(result.errors, []);
		assert.match(result.messages.join("\n"), /resumed failed durable run/);
	});

	test("keeps exact full live ids on the existing paused resume path without listing completed durable runs", async () => {
		const backend = new InMemoryDurableBackend();
		let completedCatalogReads = 0;
		const listCompletedWorkflows = backend.listCompletedWorkflows.bind(backend);
		backend.listCompletedWorkflows = () => {
			completedCatalogReads += 1;
			return listCompletedWorkflows();
		};
		setDurableBackend(backend);
		registerCompleted(backend, testRunId("exact-live-other-completed"));
		store.recordRunStart({
			id: testRunId("exact-live"),
			name: "live-flow",
			inputs: {},
			status: "paused",
			stages: [],
			startedAt: 1,
			resumable: true,
		});
		const opened: string[] = [];

		const result = await resume(testRunId("exact-live"), createExtensionRuntime({ store }), opened);

		assert.equal(result.errors.length, 0);
		assert.equal(store.runs().find((run) => run.id === testRunId("exact-live"))?.status, "running");
		assert.match(result.messages.join("\n"), new RegExp(`Resumed run ${testRunId("exact-live")}`));
		assert.equal(completedCatalogReads, 0, "an exact live run must bypass durable completed-catalog enumeration");
	});

	test("includes active recoverable blocks in the no-argument resume picker", () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		backend.registerWorkflow({
			workflowId: testRunId("picker-active-block"),
			name: "picker-flow",
			inputs: {},
			createdAt: 1,
			status: "blocked",
			resumable: true,
		});
		store.recordRunStart({
			id: testRunId("picker-active-block"),
			name: "picker-flow",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
			blockedAt: 2,
			resumable: true,
			failureRecoverability: "recoverable",
			failureDisposition: "active_blocked",
		});

		const source = collectResumePickerLiveRuns(store);

		assert.deepEqual(
			source.liveRuns.map((run) => run.id),
			[testRunId("picker-active-block")],
		);
		assert.equal(source.suppressedLiveIds.has(testRunId("picker-active-block")), false);
	});

	test("resume picker omits a paused snapshot with no durable checkpoint", () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		backend.registerWorkflow({
			workflowId: testRunId("picker-no-checkpoint"),
			name: "picker-flow",
			inputs: {},
			createdAt: 1,
			status: "paused",
			resumable: true,
		});
		store.recordRunStart({
			id: testRunId("picker-no-checkpoint"),
			name: "picker-flow",
			inputs: {},
			status: "paused",
			stages: [],
			startedAt: 1,
			resumable: true,
		});

		const source = collectResumePickerLiveRuns(store);

		assert.equal(
			source.liveRuns.some((run) => run.id === testRunId("picker-no-checkpoint")),
			false,
		);
	});

	test("suppresses a durable duplicate for a paused snapshot whose artifact is missing", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const runId = testRunId("picker-missing-artifact");
		backend.registerWorkflow({
			workflowId: runId,
			name: "picker-flow",
			inputs: {},
			createdAt: 1,
			status: "paused",
			resumable: true,
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: "stage:1",
			name: "stage",
			replayKey: "stage:1",
			output: "ok",
			completedAt: 2,
		});
		const previousRoot = process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		process.env[ENV_WORKFLOW_ARTIFACT_DIR] = tempDir;
		try {
			store.recordRunStart({
				id: runId,
				name: "picker-flow",
				inputs: {},
				status: "paused",
				stages: [],
				startedAt: 1,
				resumable: true,
				result: { transcript_path: join(tempDir, "runs", runId, "transcripts", "stage.md") },
			});
			const source = collectResumePickerLiveRuns(store);
			assert.equal(
				source.liveRuns.some((run) => run.id === runId),
				false,
			);
			assert.equal(source.suppressedLiveIds.has(runId), true);
			const catalog = await prepareWorkflowResumeCatalog(
				createExtensionRuntime({ store }),
				source.suppressedLiveIds,
			);
			assert.equal(
				catalog.resumable.some((entry) => entry.workflowId === runId),
				false,
			);
			assert.equal(
				catalog.completed.some((entry) => entry.workflowId === runId),
				false,
			);
		} finally {
			if (previousRoot === undefined) delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
			else process.env[ENV_WORKFLOW_ARTIFACT_DIR] = previousRoot;
		}
	});

	test("keeps recoverable failed and active-running explicit behavior unchanged", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		store.recordRunStart({
			id: testRunId("failed-live"),
			name: "failed-flow",
			inputs: {},
			status: "failed",
			stages: [],
			startedAt: 1,
			endedAt: 2,
			resumable: true,
		});
		store.recordRunStart({
			id: testRunId("running-live"),
			name: "running-flow",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		store.recordRunStart({
			id: testRunId("active-blocked-live"),
			name: "blocked-flow",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
			blockedAt: 2,
			resumable: true,
			failureRecoverability: "recoverable",
			failureDisposition: "active_blocked",
		});
		const baseRuntime = createExtensionRuntime({ store });
		let failedResumeCalls = 0;
		const runtime: ExtensionRuntime = {
			...baseRuntime,
			async resumeFailedRun() {
				failedResumeCalls += 1;
				return {
					ok: true,
					runId: testRunId("continued-run"),
					sourceRunId: testRunId("failed-live"),
					resumeFromStageId: "failed-stage",
					message: "continued failed workflow",
				};
			},
		};

		const failedResult = await resume(testRunId("failed-live"), runtime);
		const blockedResult = await resume(testRunId("active-blocked-live"), runtime);
		const runningResult = await resume(testRunId("running-live"), runtime);

		assert.equal(failedResumeCalls, 2);
		assert.match(failedResult.messages.join("\n"), /continued failed workflow/);
		assert.match(blockedResult.messages.join("\n"), /continued failed workflow/);
		assert.equal(blockedResult.errors.length, 0);
		assert.match(runningResult.errors.join("\n"), /already running.*connect/i);
	});
});
