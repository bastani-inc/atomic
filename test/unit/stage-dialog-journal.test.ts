import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { HostInput } from "../../packages/coding-agent/src/core/extensions/host-input.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import type { CreateAgentSessionOptions } from "../../packages/coding-agent/src/core/sdk-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	completedWorkflowRunSnapshots,
	durableWorkflowRunSnapshots,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { inspectTargetedDurableWorkflow } from "../../packages/workflows/src/durable/targeted-inspection.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { buildRuntimeAdapters } from "../../packages/workflows/src/extension/wiring.js";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import { workflowAnswerAction } from "../../packages/workflows/src/extension/workflow-tool-answer.js";
import { run as runExecutor } from "../../packages/workflows/src/runs/foreground/executor.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { adoptStageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { adoptStore } from "../../packages/workflows/src/shared/store-factory.js";
import { testRunId } from "../helpers/run-id.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

useTemporaryAgentDir();

const STAGE_PROMPT_WAIT_MS = 10_000;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	setDurableBackend(undefined);
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await closeMemoryTestBackends();
});

function sessionOptions(root: string): CreateAgentSessionOptions {
	return {
		cwd: root,
		agentDir: root,
		sessionManager: SessionManager.inMemory(root),
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
		tools: ["ask_user_question"],
	};
}

function stageSessionWithAction(
	root: string,
	action: (session: AgentSession) => Promise<string>,
	startup?: (session: AgentSession) => Promise<void>,
): (options?: CreateAgentSessionOptions) => Promise<{ session: StageSessionRuntime }> {
	return async (options) => {
		const { session } = await createAgentSession({
			...sessionOptions(root),
			...(options?.sessionManager !== undefined ? { sessionManager: options.sessionManager } : {}),
			...(options?.extensionBindings !== undefined ? { extensionBindings: options.extensionBindings } : {}),
		});
		cleanups.push(() => session.dispose());
		await startup?.(session);
		const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
		const emit = (event: { type: string; [key: string]: unknown }) => {
			for (const listener of [...listeners]) listener(event);
		};
		let messages: StageSessionRuntime["messages"] = [];
		const runtime: StageSessionRuntime & {
			bindExtensions: AgentSession["bindExtensions"];
		} = {
			get messages() {
				return messages;
			},
			get sessionFile() {
				return session.sessionFile;
			},
			get sessionId() {
				return session.sessionId;
			},
			agent: session.agent,
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			navigateTree: (async () => ({ cancelled: false })) as StageSessionRuntime["navigateTree"],
			get isStreaming() {
				return false;
			},
			bindExtensions: (bindings: Parameters<AgentSession["bindExtensions"]>[0]) => session.bindExtensions(bindings),
			async prompt() {
				const text = await action(session);
				const assistant = {
					role: "assistant" as const,
					content: [{ type: "text" as const, text }],
				} as unknown as StageSessionRuntime["messages"][number];
				messages = [assistant];
				emit({ type: "message_end", message: assistant });
				emit({ type: "agent_end", messages: [assistant] });
			},
			async steer() {},
			async followUp() {},
			subscribe(listener: Parameters<StageSessionRuntime["subscribe"]>[0]) {
				const wrapped = (event: { type: string; [key: string]: unknown }) =>
					listener(event as unknown as Parameters<typeof listener>[0]);
				listeners.add(wrapped);
				return () => listeners.delete(wrapped);
			},
			async setModel() {},
			setThinkingLevel() {},
			async cycleModel() {
				return undefined;
			},
			async cycleThinkingLevel() {
				return undefined;
			},
			async compact() {
				return {} as unknown as Awaited<ReturnType<StageSessionRuntime["compact"]>>;
			},
			abortCompaction() {},
			async abort() {},
			async dispose() {
				await session.dispose();
			},
		};
		return { session: runtime };
	};
}

test("stage dialogs journal their pending prompt kind and settlement in the workflow journal and answer via workflow answer", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-dialog-journal-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const backend = await createMemoryTestBackend();
	const scope = {};
	const store = adoptStore(scope);
	const broker = adoptStageUiBroker(scope, false, store);
	const owner = { ...captureWorkflowOwnerResources(), store, stageUiBroker: broker };
	const runId = testRunId("stage-dialog-journal");

	const def = workflow({
		name: "stage-dialog-journal",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("asker").prompt("run with permission and selection");
			return {};
		},
	});

	const adapters = buildRuntimeAdapters(
		{},
		{
			stageUiBroker: broker,
			createAgentSession: stageSessionWithAction(root, async (session) => {
				const ui = session.extensionRunner.createContext().ui;
				const allowed = await ui.confirm("Allow rm?", "Delete generated files");
				const target = await ui.select("Pick environment", ["staging", "prod"]);
				return `${allowed}:${target}`;
			}),
		},
	);

	const runPromise = run(def, {}, { runId, store, stageUiBroker: broker, durableBackend: backend, adapters });

	await vi.waitFor(
		() => {
			const readerStages = durableWorkflowRunSnapshots(backend, backend.getWorkflow(runId)!)[0]?.stages;
			assert.equal(readerStages?.[0]?.status, "awaiting_input");
			assert.equal(readerStages?.[0]?.pendingPrompt?.kind, "confirm");
		},
		{ timeout: STAGE_PROMPT_WAIT_MS },
	);

	const reopenedWhileConfirm = await JournalDurableBackend.open(backend.journal, { ownsJournal: false });
	cleanups.push(() => reopenedWhileConfirm.close());
	const inspectedConfirm = await inspectTargetedDurableWorkflow(reopenedWhileConfirm, runId);
	assert.equal(inspectedConfirm.kind, "found");
	const confirmStage = inspectedConfirm.detail.stages[0]!;
	assert.equal(confirmStage.status, "awaiting_input");
	assert.equal(confirmStage.endedAt, undefined);
	assert.equal(confirmStage.pendingPrompt?.kind, "confirm");
	assert.match(confirmStage.pendingPrompt?.message ?? "", /Allow rm\?/);
	assert.equal(confirmStage.promptFootprint?.kind, "confirm");

	const confirmAnswer = await workflowAnswerAction(
		{
			action: "answer",
			runId,
			stageId: confirmStage.id,
			promptId: confirmStage.pendingPrompt!.id,
			response: "yes",
		},
		owner,
	);
	assert.equal(confirmAnswer.status, "ok");

	await vi.waitFor(
		() => {
			const readerStages = durableWorkflowRunSnapshots(backend, backend.getWorkflow(runId)!)[0]?.stages;
			assert.equal(readerStages?.[0]?.status, "awaiting_input");
			assert.equal(readerStages?.[0]?.pendingPrompt?.kind, "select");
		},
		{ timeout: STAGE_PROMPT_WAIT_MS },
	);

	const selectStage = durableWorkflowRunSnapshots(backend, backend.getWorkflow(runId)!)[0]!.stages[0]!;
	assert.deepEqual(selectStage.pendingPrompt?.choices, ["staging", "prod"]);

	const selectAnswer = await workflowAnswerAction(
		{
			action: "answer",
			runId,
			stageId: selectStage.id,
			promptId: selectStage.pendingPrompt!.id,
			response: "prod",
		},
		owner,
	);
	assert.equal(selectAnswer.status, "ok");

	const result = await runPromise;
	assert.equal(result.status, "completed", result.error);

	const reopenedCompleted = await JournalDurableBackend.open(backend.journal, { ownsJournal: false });
	cleanups.push(() => reopenedCompleted.close());
	await reopenedCompleted.hydrateWorkflow(runId);
	const completedEntry = reopenedCompleted.listCompletedWorkflows().find((entry) => entry.workflowId === runId);
	assert.ok(completedEntry, "completed workflow must be in durable catalog");
	const completedRuns = await completedWorkflowRunSnapshots(reopenedCompleted, completedEntry);
	assert.equal(completedRuns.length, 1);
	assert.equal(completedRuns[0]!.stages.length, 1, "stage checkpoints must merge into one stage without duplicates");
	const finalStage = completedRuns[0]!.stages[0]!;
	assert.equal(finalStage.status, "completed");
	assert.equal(finalStage.pendingPrompt, undefined);
	assert.equal(finalStage.promptFootprint?.kind, "select");
	assert.equal(finalStage.promptAnswerState, "unavailable");
	assert.equal(finalStage.result, "true:prod");
});

test("a synchronously answered SDK stage dialog still journals its pending prompt kind before its settlement", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-dialog-sync-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const backend = await createMemoryTestBackend();
	const scope = {};
	const store = adoptStore(scope);
	const broker = adoptStageUiBroker(scope, false, store);
	const runId = testRunId("stage-dialog-sync");

	const host: HostInput = {
		confirm: async () => true,
		select: async (_title, choices) => choices[0],
		input: async () => "private-token-value",
		editor: async () => "edited",
		questionnaire: async () => ({ answers: [], cancelled: true }),
	};

	const def = workflow({
		name: "stage-dialog-sync",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("asker").prompt("ask input");
			return {};
		},
	});

	const adapters = buildRuntimeAdapters(
		{},
		{
			stageUiBroker: broker,
			createAgentSession: stageSessionWithAction(root, async (session) => {
				await session.bindExtensions({ humanInput: host });
				const secret = await session.extensionRunner.createContext().ui.input("Token", "Enter token");
				return `got:${secret?.length ?? 0}`;
			}),
		},
	);

	const result = await run(def, {}, { runId, store, stageUiBroker: broker, durableBackend: backend, adapters });
	assert.equal(result.status, "completed", result.error);

	const stageCheckpoints = backend
		.listCheckpoints(runId)
		.filter((checkpoint): checkpoint is DurableStageCheckpoint => checkpoint.kind === "stage");
	assert.ok(
		stageCheckpoints.some(
			(checkpoint) => checkpoint.topology?.status === "awaiting_input" && checkpoint.pendingPrompt?.kind === "input",
		),
		"journal must retain the awaiting_input checkpoint with its pendingPrompt kind even when answered in the same tick",
	);
	assert.ok(
		stageCheckpoints.some(
			(checkpoint) =>
				checkpoint.topology?.status === "running" &&
				checkpoint.pendingPrompt === undefined &&
				checkpoint.promptFootprint?.kind === "input" &&
				checkpoint.promptAnswerState === "available",
		),
		"journal must record the settled running checkpoint after the dialog resolves",
	);
	assert.equal(
		JSON.stringify(backend.listCheckpoints(runId)).includes("private-token-value"),
		false,
		"raw dialog answer must never be persisted in journal checkpoints",
	);
});

test("session checkpoint callbacks wait for earlier dialog writes before starting", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-dialog-order-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const scope = {};
	const store = adoptStore(scope);
	const broker = adoptStageUiBroker(scope, false, store);
	const owner = { ...captureWorkflowOwnerResources(), store, stageUiBroker: broker };
	const runId = testRunId("stage-dialog-order");
	const pendingWrite = Promise.withResolvers<void>();
	const writeStarted = Promise.withResolvers<void>();
	const metadataStarted = Promise.withResolvers<void>();
	const metadataResult = Promise.withResolvers<void>();
	let sawDialog = false;
	let metadataCalled = false;
	const definition = workflow({
		name: "stage-dialog-order",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("asker").prompt("ask");
			return {};
		},
	});
	const result = runExecutor(
		definition,
		{},
		{
			runId,
			store,
			stageUiBroker: broker,
			adapters: buildRuntimeAdapters(
				{},
				{
					stageUiBroker: broker,
					createAgentSession: stageSessionWithAction(root, async (session) => {
						await session.extensionRunner.createContext().ui.input("Name");
						return "answered";
					}),
				},
			),
			onStageSession: async (_runId, snapshot) => {
				if (snapshot.pendingPrompt !== undefined) {
					sawDialog = true;
					writeStarted.resolve();
					return pendingWrite.promise;
				}
				if (!sawDialog) return;
				metadataCalled = true;
				metadataStarted.resolve();
				return metadataResult.promise;
			},
		},
	);
	void result.catch(() => {});
	try {
		await writeStarted.promise;
		await setImmediate();
		assert.equal(store.run(runId)!.stages[0]!.pendingPrompt, undefined, "the dialog waits for its write");
		assert.equal(metadataCalled, false, "later session metadata must not overtake an outstanding dialog write");
	} finally {
		pendingWrite.resolve();
		await vi.waitFor(() => assert.equal(store.run(runId)?.stages[0]?.pendingPrompt?.kind, "input"));
		const stage = store.run(runId)!.stages[0]!;
		assert.equal(
			(
				await workflowAnswerAction(
					{ action: "answer", runId, stageId: stage.id, promptId: stage.pendingPrompt!.id, response: "Ada" },
					owner,
				)
			).status,
			"ok",
		);
		await metadataStarted.promise;
		metadataResult.reject(new Error("session metadata refused"));
		const outcome = await result;
		assert.equal(outcome.status, "failed");
		assert.match(outcome.error ?? "", /session metadata refused/);
	}
});

test("an interrupted run never auto-approves or reuses an earlier stage permission dialog on resume", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-dialog-crash-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const backend = await createMemoryTestBackend();
	const runId = testRunId("stage-dialog-crash");

	const def = workflow({
		name: "stage-dialog-crash",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("asker").prompt("deploy");
			return {};
		},
	});

	const firstScope = {};
	const firstStore = adoptStore(firstScope);
	const firstBroker = adoptStageUiBroker(firstScope, false, firstStore);
	const firstOwner = { ...captureWorkflowOwnerResources(), store: firstStore, stageUiBroker: firstBroker };
	let holdAfterApprove = Promise.withResolvers<void>();

	const firstAdapters = buildRuntimeAdapters(
		{},
		{
			stageUiBroker: firstBroker,
			createAgentSession: stageSessionWithAction(root, async (session) => {
				const approved = await session.extensionRunner
					.createContext()
					.ui.confirm("Allow deploy?", "Deploy to production");
				await holdAfterApprove.promise;
				return `approved:${approved}`;
			}),
		},
	);

	const firstRun = run(
		def,
		{},
		{
			runId,
			store: firstStore,
			stageUiBroker: firstBroker,
			durableBackend: backend,
			defaultSessionDir: root,
			adapters: firstAdapters,
		},
	);

	await vi.waitFor(() => assert.equal(firstStore.run(runId)?.stages[0]?.pendingPrompt?.kind, "confirm"), {
		timeout: STAGE_PROMPT_WAIT_MS,
	});
	const firstPrompt = firstStore.run(runId)!.stages[0]!.pendingPrompt!;
	const firstStageId = firstStore.run(runId)!.stages[0]!.id;
	assert.equal(
		(
			await workflowAnswerAction(
				{ action: "answer", runId, stageId: firstStageId, promptId: firstPrompt.id, response: true },
				firstOwner,
			)
		).status,
		"ok",
	);

	// Interrupt the first execution after the permission was approved but before the stage completed.
	holdAfterApprove.reject(new Error("simulated stage interruption"));
	const firstOutcome = await firstRun;
	assert.equal(firstOutcome.status, "failed");

	// Resume in a fresh store/broker: the stage must ask again and never reuse the prior approval.
	holdAfterApprove = Promise.withResolvers<void>();
	holdAfterApprove.resolve();
	const secondScope = {};
	const secondStore = adoptStore(secondScope);
	const secondBroker = adoptStageUiBroker(secondScope, false, secondStore);
	const secondOwner = { ...captureWorkflowOwnerResources(), store: secondStore, stageUiBroker: secondBroker };
	const secondAdapters = buildRuntimeAdapters(
		{},
		{
			stageUiBroker: secondBroker,
			createAgentSession: stageSessionWithAction(root, async (session) => {
				const approved = await session.extensionRunner
					.createContext()
					.ui.confirm("Allow deploy?", "Deploy to production");
				return `approved:${approved}`;
			}),
		},
	);

	const secondRun = run(
		def,
		{},
		{
			runId,
			store: secondStore,
			stageUiBroker: secondBroker,
			durableBackend: backend,
			defaultSessionDir: root,
			adapters: secondAdapters,
		},
	);

	await vi.waitFor(() => assert.equal(secondStore.run(runId)?.stages[0]?.pendingPrompt?.kind, "confirm"), {
		timeout: STAGE_PROMPT_WAIT_MS,
	});
	const secondPrompt = secondStore.run(runId)!.stages[0]!.pendingPrompt!;
	const secondStageId = secondStore.run(runId)!.stages[0]!.id;
	assert.notEqual(secondPrompt.id, firstPrompt.id);
	assert.equal(
		(
			await workflowAnswerAction(
				{ action: "answer", runId, stageId: secondStageId, promptId: secondPrompt.id, response: false },
				secondOwner,
			)
		).status,
		"ok",
	);

	const secondResult = await secondRun;
	assert.equal(secondResult.status, "completed", secondResult.error);
	assert.equal(secondResult.stages[0]?.result, "approved:false");
});

test("a stage dialog whose durable checkpoint write is refused fails the stage closed instead of completing unjournalled", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-dialog-refusal-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const backend = await createMemoryTestBackend();
	const scope = {};
	const store = adoptStore(scope);
	const broker = adoptStageUiBroker(scope, false, store);
	const runId = testRunId("stage-dialog-refusal");

	const originalCommit = backend.commitCheckpoint.bind(backend);
	backend.commitCheckpoint = async (checkpoint, options) => {
		if (checkpoint.kind === "stage" && checkpoint.pendingPrompt !== undefined) {
			throw new Error("journal storage refused stage dialog checkpoint");
		}
		return originalCommit(checkpoint, options);
	};

	const def = workflow({
		name: "stage-dialog-refusal",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("asker").prompt("ask confirm");
			return {};
		},
	});

	const adapters = buildRuntimeAdapters(
		{},
		{
			stageUiBroker: broker,
			createAgentSession: stageSessionWithAction(root, async (session) => {
				const approved = await session.extensionRunner
					.createContext()
					.ui.confirm("Allow deploy?", "Deploy to production");
				return `completed-after-refusal:${approved}`;
			}),
		},
	);

	const result = await run(def, {}, { runId, store, stageUiBroker: broker, durableBackend: backend, adapters });
	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /journal storage refused stage dialog checkpoint/);
	assert.equal(result.stages[0]?.status, "failed");
	assert.equal(result.stages[0]?.pendingPrompt, undefined);
});

function holdDialogRequestCommits(backend: Awaited<ReturnType<typeof createMemoryTestBackend>>) {
	const release = Promise.withResolvers<void>();
	const requested = Promise.withResolvers<void>();
	const state = { committed: false, requested: requested.promise, release: () => release.resolve() };
	const originalCommit = backend.commitCheckpoint.bind(backend);
	backend.commitCheckpoint = async (checkpoint, options) => {
		if (checkpoint.kind !== "stage" || checkpoint.pendingPrompt === undefined)
			return originalCommit(checkpoint, options);
		requested.resolve();
		await release.promise;
		const committed = await originalCommit(checkpoint, options);
		state.committed = true;
		return committed;
	};
	return state;
}

test("an SDK host is asked a stage dialog only after its request checkpoint is durable", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-dialog-host-durable-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const backend = await createMemoryTestBackend();
	const scope = {};
	const store = adoptStore(scope);
	const broker = adoptStageUiBroker(scope, false, store);
	const runId = testRunId("stage-dialog-host-durable");
	const request = holdDialogRequestCommits(backend);
	const askedAfterCommit: boolean[] = [];
	const host: HostInput = {
		confirm: async () => {
			askedAfterCommit.push(request.committed);
			return true;
		},
		select: async () => undefined,
		input: async () => undefined,
		editor: async () => undefined,
		questionnaire: async () => ({ answers: [], cancelled: true }),
	};
	const def = workflow({
		name: "stage-dialog-host-durable",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("asker").prompt("deploy");
			return {};
		},
	});
	const adapters = buildRuntimeAdapters(
		{},
		{
			stageUiBroker: broker,
			createAgentSession: stageSessionWithAction(root, async (session) => {
				await session.bindExtensions({ humanInput: host });
				return `approved:${await session.extensionRunner.createContext().ui.confirm("Allow deploy?", "Deploy")}`;
			}),
		},
	);
	const result = run(def, {}, { runId, store, stageUiBroker: broker, durableBackend: backend, adapters });
	await request.requested;
	for (let turn = 0; turn < 5; turn++) await setImmediate();
	assert.deepEqual(askedAfterCommit, [], "the SDK host is not asked while the request is not yet durable");
	request.release();
	const outcome = await result;
	assert.equal(outcome.status, "completed", outcome.error);
	assert.deepEqual(askedAfterCommit, [true]);
	assert.equal(outcome.stages[0]?.result, "approved:true");
});

test("a stage dialog is neither shown nor answerable before its request checkpoint is durable", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-dialog-answer-durable-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const backend = await createMemoryTestBackend();
	const scope = {};
	const store = adoptStore(scope);
	const broker = adoptStageUiBroker(scope, false, store);
	const owner = { ...captureWorkflowOwnerResources(), store, stageUiBroker: broker };
	const runId = testRunId("stage-dialog-answer-durable");
	const request = holdDialogRequestCommits(backend);
	const actedAfterCommit: boolean[] = [];
	const def = workflow({
		name: "stage-dialog-answer-durable",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("asker").prompt("deploy");
			return {};
		},
	});
	const adapters = buildRuntimeAdapters(
		{},
		{
			stageUiBroker: broker,
			createAgentSession: stageSessionWithAction(root, async (session) => {
				const approved = await session.extensionRunner.createContext().ui.confirm("Allow deploy?", "Deploy");
				actedAfterCommit.push(request.committed);
				return `approved:${approved}`;
			}),
		},
	);
	const result = run(def, {}, { runId, store, stageUiBroker: broker, durableBackend: backend, adapters });
	await request.requested;
	for (let turn = 0; turn < 5; turn++) await setImmediate();
	const waiting = store.run(runId)!.stages[0]!;
	assert.equal(
		waiting.pendingPrompt,
		undefined,
		"no stage chat or workflow answer sees the dialog before it is durable",
	);
	assert.notEqual(waiting.status, "awaiting_input");
	request.release();
	await vi.waitFor(() => assert.equal(store.run(runId)?.stages[0]?.pendingPrompt?.kind, "confirm"), {
		timeout: STAGE_PROMPT_WAIT_MS,
	});
	const stage = store.run(runId)!.stages[0]!;
	assert.equal(
		(
			await workflowAnswerAction(
				{ action: "answer", runId, stageId: stage.id, promptId: stage.pendingPrompt!.id, response: true },
				owner,
			)
		).status,
		"ok",
	);
	const outcome = await result;
	assert.equal(outcome.status, "completed", outcome.error);
	assert.deepEqual(actedAfterCommit, [true]);
	assert.equal(outcome.stages[0]?.result, "approved:true");
});

test("a dialog a stage asks while its session is still being created waits for its durable request", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-dialog-startup-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const backend = await createMemoryTestBackend();
	const scope = {};
	const store = adoptStore(scope);
	const broker = adoptStageUiBroker(scope, false, store);
	const runId = testRunId("stage-dialog-startup");
	const request = holdDialogRequestCommits(backend);
	const askedAfterCommit: boolean[] = [];
	const hostAsked = Promise.withResolvers<void>();
	const host: HostInput = {
		confirm: async () => {
			askedAfterCommit.push(request.committed);
			hostAsked.resolve();
			return true;
		},
		select: async () => undefined,
		input: async () => undefined,
		editor: async () => undefined,
		questionnaire: async () => ({ answers: [], cancelled: true }),
	};
	let startupApproved: boolean | undefined;
	const def = workflow({
		name: "stage-dialog-startup",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("asker").prompt("start");
			return {};
		},
	});
	const adapters = buildRuntimeAdapters(
		{},
		{
			stageUiBroker: broker,
			createAgentSession: stageSessionWithAction(
				root,
				async () => `startup:${startupApproved}`,
				async (session) => {
					await session.bindExtensions({ humanInput: host });
					startupApproved = await session.extensionRunner.createContext().ui.confirm("Allow setup?", "Startup");
				},
			),
		},
	);
	const result = run(def, {}, { runId, store, stageUiBroker: broker, durableBackend: backend, adapters });
	await Promise.race([request.requested, hostAsked.promise]);
	for (let turn = 0; turn < 5; turn++) await setImmediate();
	assert.deepEqual(askedAfterCommit, [], "a startup dialog is not answered before its request is durable");
	assert.equal(store.run(runId)!.stages[0]!.pendingPrompt, undefined);
	request.release();
	const outcome = await result;
	assert.equal(outcome.status, "completed", outcome.error);
	assert.deepEqual(askedAfterCommit, [true]);
	assert.equal(outcome.stages[0]?.result, "startup:true");
});
