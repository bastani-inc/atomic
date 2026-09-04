import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { closeWorkflowStageGeneration } from "../../packages/coding-agent/src/core/agent-session-message-queue.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { resolveSubagentIntercomTarget } from "../../packages/subagents/src/intercom/intercom-bridge.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import registerSubagentNotify from "../../packages/subagents/src/runs/foreground/notify.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import {
	INTERCOM_DETACH_REQUEST_EVENT,
	type RunSyncOptions,
	type SingleResult,
	type SubagentState,
} from "../../packages/subagents/src/shared/types.js";
import { fileExistsSync, makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const roots: string[] = [];

afterEach(() => {
	clearSubagentControls();
	for (const root of roots.splice(0)) removeTempDirectory(root);
});

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "Worker",
		source: "project",
		filePath: "worker.md",
		systemPrompt: "Work.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
	};
}

function eventBus(emitter: EventEmitter) {
	return {
		on(channel: string, handler: (payload: unknown) => void) {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
		emit(channel: string, payload: unknown) {
			emitter.emit(channel, payload);
		},
	};
}

function state(root: string): SubagentState {
	return {
		baseCwd: root,
		currentSessionId: "stage-session",
		subagentInProgress: false,
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
}

function stageContext(root: string, boundary: WorkflowStageAdmissionBoundary, stageId: string): ExtensionContext {
	return {
		cwd: root,
		mode: "tui",
		hasUI: false,
		ui: {},
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => join(root, `${stageId}.jsonl`),
			getSessionId: () => `session-${stageId}`,
			getLeafId: () => null,
			getEntries: () => [],
		},
		orchestrationContext: {
			kind: "workflow-stage",
			workflowRunId: "workflow-run",
			workflowStageId: stageId,
			workflowStageName: stageId,
			constraints: { disableWorkflowTool: true },
			messageAdmission: { boundary, extensionState: new Map(), isOpen: () => boundary.isOpen() },
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

interface Harness {
	readonly execute: ReturnType<typeof createSubagentExecutor>["execute"];
	readonly emittedNotifications: string[];
	readonly detachedResults: SingleResult[];
	readonly launched: Promise<RunSyncOptions>;
	readonly unregisterNotify: () => void;
}

function harness(root: string, emitter: EventEmitter, gates: readonly Promise<void>[]): Harness {
	const bus = eventBus(emitter);
	const emittedNotifications: string[] = [];
	const detachedResults: SingleResult[] = [];
	const launch = Promise.withResolvers<RunSyncOptions>();
	let nextGate = 0;
	const pi = {
		events: bus,
		getSessionName: () => "stage-parent",
		sendMessage(message: { content?: string }) {
			emittedNotifications.push(message.content ?? "");
		},
	};
	const unregisterNotify = registerSubagentNotify(pi as never);
	const execute = createSubagentExecutor({
		pi: pi as unknown as ExecutorDeps["pi"],
		state: state(root),
		config: { intercomBridge: { mode: "always" }, parallel: { concurrency: 4, maxTasks: 50 } },
		tempArtifactsDir: join(root, "artifacts"),
		getSubagentSessionRoot: () => join(root, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [agent()] }),
		runtime: {
			runSync: async (cwd, agents, agentName, task, options) => {
				launch.resolve(options);
				const gate = gates[nextGate++] ?? Promise.resolve();
				const onDetachedExit = options.onDetachedExit;
				return runSync(cwd, agents, agentName, task, {
					...options,
					testSession: { output: `${task} result`, promptGate: gate, abortResolvesPrompt: true },
					onDetachedExit(result) {
						detachedResults.push(result);
						onDetachedExit?.(result);
					},
				});
			},
		},
	});
	return {
		execute: execute.execute,
		emittedNotifications,
		detachedResults,
		launched: launch.promise,
		unregisterNotify,
	};
}

async function detach(bus: ReturnType<typeof eventBus>, options: RunSyncOptions, index: number): Promise<void> {
	const request = {
		requestId: `detach-${index}`,
		messageId: `detach-${index}`,
		senderId: "child",
		runtimeGeneration: 1,
		childIntercomTarget: options.intercomSessionName ?? resolveSubagentIntercomTarget(options.runId, "worker", index),
	};
	bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...request, phase: "probe" });
	await sleep(1);
	bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...request, phase: "commit" });
}

async function waitForResults(results: readonly SingleResult[], count: number): Promise<void> {
	for (let attempt = 0; attempt < 100 && results.length < count; attempt++) await sleep(5);
	assert.equal(results.length, count, "detached child exits should settle");
}

async function closeStage(boundary: WorkflowStageAdmissionBoundary): Promise<void> {
	await closeWorkflowStageGeneration.call({
		_workflowStageAdmission: boundary,
		agent: { waitForIdle: async () => {} },
		_agentEventQueue: Promise.resolve(),
	} as never);
}

test("closing a workflow stage cancels its detached single child without a late parent notification", async () => {
	const root = makeTempDirectory("atomic-stage-child-cancel-single-");
	roots.push(root);
	const gate = Promise.withResolvers<void>();
	const emitter = new EventEmitter();
	const bus = eventBus(emitter);
	const boundary = new WorkflowStageAdmissionBoundary();
	const run = harness(root, emitter, [gate.promise]);
	try {
		const execution = run.execute(
			"tool-call",
			{ agent: "worker", task: "single", progress: true, artifacts: false },
			new AbortController().signal,
			undefined,
			stageContext(root, boundary, "stage-a"),
		);
		const launched = await run.launched;
		await sleep(10);
		await detach(bus, launched, 0);
		assert.equal((await execution).details?.results[0]?.detached, true);

		await closeStage(boundary);
		await waitForResults(run.detachedResults, 1);
		assert.equal(run.detachedResults[0]?.status, "interrupted");
		assert.equal(run.detachedResults[0]?.cause, "abort");
		assert.deepEqual(run.emittedNotifications, []);
		await closeStage(boundary);
		assert.equal(run.detachedResults.length, 1, "repeated close is idempotent");
		assert.equal(emitter.listenerCount(INTERCOM_DETACH_REQUEST_EVENT), 0);
		assert.equal(fileExistsSync(join(root, "subagent-artifacts", "progress", launched.runId)), false);
	} finally {
		gate.resolve();
		run.unregisterNotify();
	}
});

test("closing one stage cancels every detached parallel child but leaves another stage live", async () => {
	const root = makeTempDirectory("atomic-stage-child-cancel-parallel-");
	roots.push(root);
	const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const emitterA = new EventEmitter();
	const emitterB = new EventEmitter();
	const busA = eventBus(emitterA);
	const busB = eventBus(emitterB);
	const boundaryA = new WorkflowStageAdmissionBoundary();
	const boundaryB = new WorkflowStageAdmissionBoundary();
	const stageA = harness(root, emitterA, [gates[0]!.promise, gates[1]!.promise]);
	const stageB = harness(root, emitterB, [gates[2]!.promise]);
	try {
		const parallel = stageA.execute(
			"parallel-call",
			{
				tasks: [
					{ agent: "worker", task: "first" },
					{ agent: "worker", task: "second" },
				],
				artifacts: false,
			},
			new AbortController().signal,
			undefined,
			stageContext(root, boundaryA, "stage-a"),
		);
		const unrelated = stageB.execute(
			"single-call",
			{ agent: "worker", task: "unrelated", artifacts: false },
			new AbortController().signal,
			undefined,
			stageContext(root, boundaryB, "stage-b"),
		);
		const [launchedA, launchedB] = await Promise.all([stageA.launched, stageB.launched]);
		await sleep(10);
		await detach(busA, launchedA, 0);
		await detach(busB, launchedB, 0);
		assert.equal((await unrelated).details?.results[0]?.detached, true);
		const parallelResult = await parallel;
		assert.ok(parallelResult.details?.results.every((result) => result.detached === true));

		await closeStage(boundaryA);
		await waitForResults(stageA.detachedResults, 2);
		assert.deepEqual(
			stageA.detachedResults.map((result) => [result.status, result.cause]),
			[
				["interrupted", "abort"],
				["interrupted", "abort"],
			],
		);
		assert.equal(stageB.detachedResults.length, 0, "another stage remains live");
		assert.deepEqual(stageA.emittedNotifications, []);

		gates[2]!.resolve();
		await waitForResults(stageB.detachedResults, 1);
		assert.equal(stageB.detachedResults[0]?.status, "ok");
		assert.equal(stageB.emittedNotifications.length, 1, "live-stage detached completion still notifies");
		await closeStage(boundaryB);
		assert.equal(stageB.detachedResults.length, 1, "closing after child completion is harmless");
		assert.equal(emitterA.listenerCount(INTERCOM_DETACH_REQUEST_EVENT), 0);
		assert.equal(emitterB.listenerCount(INTERCOM_DETACH_REQUEST_EVENT), 0);
	} finally {
		for (const gate of gates) gate.resolve();
		stageA.unregisterNotify();
		stageB.unregisterNotify();
	}
});
