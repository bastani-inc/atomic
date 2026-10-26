import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import {
	isStaleExtensionContextError,
	STALE_EXTENSION_CONTEXT_MESSAGE,
} from "../../packages/coding-agent/src/core/extensions/stale-context.js";
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
} from "../../packages/subagents/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const roots: string[] = [];

afterEach(() => {
	clearSubagentControls();
	for (const root of roots.splice(0)) removeTempDirectory(root);
});

const worker: AgentConfig = {
	name: "worker",
	description: "Worker",
	source: "project",
	filePath: "worker.md",
	systemPrompt: "Work.",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

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

/** A workflow stage's tool context whose session model fallback later retires: every read then throws. */
function retirableStageContext(root: string, boundary: WorkflowStageAdmissionBoundary) {
	let retired = false;
	const live = <T>(value: T): T => {
		if (retired) throw new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
		return value;
	};
	const orchestrationContext = {
		kind: "workflow-stage",
		workflowRunId: "workflow-run",
		workflowStageId: "stage",
		workflowStageName: "stage",
		constraints: { disableWorkflowTool: true },
		messageAdmission: { boundary, extensionState: new Map(), isOpen: () => boundary.isOpen() },
	};
	const ctx = {
		cwd: root,
		mode: "tui",
		hasUI: false,
		ui: {},
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => join(root, "stage.jsonl"),
			getSessionId: () => "session-stage",
			getLeafId: () => null,
			getEntries: () => [],
		},
		get orchestrationContext() {
			return live(orchestrationContext);
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
	return {
		ctx,
		retire: () => {
			retired = true;
		},
	};
}

test("a detached subagent that exits after model fallback retired its launching session still reports its completion (#3981)", async () => {
	const root = makeTempDirectory("atomic-detached-exit-retired-3981-");
	roots.push(root);
	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onRejection);
	const emitter = new EventEmitter();
	const bus = eventBus(emitter);
	const boundary = new WorkflowStageAdmissionBoundary();
	const gate = Promise.withResolvers<void>();
	const launch = Promise.withResolvers<RunSyncOptions>();
	const detachedResults: SingleResult[] = [];
	const notifications: string[] = [];
	const pi = {
		events: bus,
		getSessionName: () => "stage-parent",
		sendMessage(message: { content?: string }) {
			notifications.push(message.content ?? "");
		},
	};
	const unregisterNotify = registerSubagentNotify(pi as never);
	const executor = createSubagentExecutor({
		pi: pi as unknown as ExecutorDeps["pi"],
		state: {
			baseCwd: root,
			currentSessionId: "session-stage",
			subagentInProgress: false,
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
		},
		config: { intercomBridge: { mode: "always" }, parallel: { concurrency: 4, maxTasks: 50 } },
		tempArtifactsDir: join(root, "artifacts"),
		getSubagentSessionRoot: () => join(root, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [worker] }),
		runtime: {
			runSync: async (cwd, agents, agentName, task, options) => {
				launch.resolve(options);
				const onDetachedExit = options.onDetachedExit;
				return runSync(cwd, agents, agentName, task, {
					...options,
					testSession: { output: `${task} result`, promptGate: gate.promise },
					onDetachedExit(result) {
						detachedResults.push(result);
						onDetachedExit?.(result);
					},
				});
			},
		},
	});
	const stage = retirableStageContext(root, boundary);
	try {
		const execution = executor.execute(
			"tool-call",
			{ agent: "worker", task: "single", artifacts: false },
			new AbortController().signal,
			undefined,
			stage.ctx,
		);
		const launched = await launch.promise;
		await sleep(10);
		const request = {
			requestId: "detach-0",
			messageId: "detach-0",
			senderId: "child",
			runtimeGeneration: 1,
			childIntercomTarget:
				launched.intercomSessionName ?? resolveSubagentIntercomTarget(launched.runId, "worker", 0),
		};
		bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...request, phase: "probe" });
		await sleep(1);
		bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...request, phase: "commit" });
		assert.equal((await execution).details?.results[0]?.detached, true);

		// Model fallback replaces the stage session that launched the child; the stage itself stays open.
		stage.retire();
		gate.resolve();

		for (let attempt = 0; attempt < 100 && notifications.length === 0; attempt++) await sleep(5);
		assert.equal(detachedResults.length, 1);
		assert.deepEqual(rejections.filter(isStaleExtensionContextError), []);
		assert.equal(notifications.length, 1, "the parent still learns that its detached child finished");
		assert.match(notifications[0]!, /single result/);
	} finally {
		gate.resolve();
		unregisterNotify();
		process.off("unhandledRejection", onRejection);
	}
});
