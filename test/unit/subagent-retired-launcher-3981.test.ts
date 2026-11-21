import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import {
	isStaleExtensionContextError,
	STALE_EXTENSION_CONTEXT_MESSAGE,
} from "../../packages/coding-agent/src/core/extensions/stale-context.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { resolveSubagentIntercomTarget } from "../../packages/subagents/src/intercom/intercom-bridge.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import registerSubagentNotify from "../../packages/subagents/src/runs/foreground/notify.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
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

/** A tool context whose session model fallback later retires: every read then throws. */
function retirableContext(root: string) {
	let retired = false;
	const live = <T>(value: T): T => {
		if (retired) throw new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
		return value;
	};
	const ctx = {
		get cwd() {
			return live(root);
		},
		mode: "tui",
		hasUI: false,
		ui: {},
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => join(root, "parent.jsonl"),
			getSessionId: () => "session-parent",
			getLeafId: () => null,
			getEntries: () => [],
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

type RunSync = SubagentExecutorRuntimeDeps["runSync"];

function executorFor(root: string, emitter: EventEmitter, runtimeRunSync: RunSync) {
	const notifications: string[] = [];
	const notified = Promise.withResolvers<void>();
	const pi = {
		events: eventBus(emitter),
		getSessionName: () => "parent",
		sendMessage(message: { content?: string }) {
			notifications.push(message.content ?? "");
			notified.resolve();
		},
	};
	const unregisterNotify = registerSubagentNotify(pi as never);
	const executor = createSubagentExecutor({
		pi: pi as unknown as ExecutorDeps["pi"],
		state: {
			baseCwd: root,
			currentSessionId: "session-parent",
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
		runtime: { runSync: runtimeRunSync },
	});
	return { executor, notifications, notified: notified.promise, unregisterNotify };
}

/** Node reports a rejection left unhandled once the turn that left it has run its microtasks. */
function unhandledRejectionsReported(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function captureRejections() {
	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onRejection);
	return {
		stale: () => rejections.filter(isStaleExtensionContextError),
		stop: () => process.off("unhandledRejection", onRejection),
	};
}

test("a detached subagent that exits after model fallback retired its launching session still reports its completion (#3981)", async () => {
	const root = makeTempDirectory("atomic-detached-exit-retired-3981-");
	roots.push(root);
	const rejections = captureRejections();
	const emitter = new EventEmitter();
	const bus = eventBus(emitter);
	const gate = Promise.withResolvers<void>();
	const launch = Promise.withResolvers<RunSyncOptions>();
	const detachedResults: SingleResult[] = [];
	const { executor, notifications, notified, unregisterNotify } = executorFor(
		root,
		emitter,
		async (cwd, agents, agentName, task, options) => {
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
	);
	const parent = retirableContext(root);
	try {
		const execution = executor.execute(
			"tool-call",
			{ agent: "worker", task: "single", artifacts: false },
			new AbortController().signal,
			undefined,
			parent.ctx,
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

		// Model fallback replaces the session that launched the child.
		parent.retire();
		gate.resolve();

		await notified;
		await unhandledRejectionsReported();
		assert.equal(detachedResults.length, 1);
		assert.deepEqual(rejections.stale(), []);
		assert.equal(notifications.length, 1, "the parent still learns that its detached child finished");
		assert.match(notifications[0]!, /single result/);
	} finally {
		gate.resolve();
		unregisterNotify();
		rejections.stop();
	}
});

test("the completion check still sees a stale rejection left unhandled by the turn that delivered the notice (#4454)", async () => {
	const rejections = captureRejections();
	const delivered = Promise.withResolvers<void>();
	try {
		setImmediate(() => {
			void Promise.reject(new Error(STALE_EXTENSION_CONTEXT_MESSAGE));
			delivered.resolve();
		});
		await delivered.promise;
		await unhandledRejectionsReported();
		assert.equal(rejections.stale().length, 1);
	} finally {
		rejections.stop();
	}
});

test("a queued subagent without a task host starts in its launch directory after model fallback retired its launching session (#3981)", async () => {
	const root = makeTempDirectory("atomic-queued-ownerless-retired-3981-");
	roots.push(root);
	const rejections = captureRejections();
	const parent = retirableContext(root);
	const started: string[] = [];
	const firstRunning = Promise.withResolvers<void>();
	const firstGate = Promise.withResolvers<void>();
	const { executor, unregisterNotify } = executorFor(
		root,
		new EventEmitter(),
		async (cwd, agents, agentName, task, options) => {
			started.push(cwd);
			const first = task.includes("first");
			if (first) firstRunning.resolve();
			return runSync(cwd, agents, agentName, task, {
				...options,
				testSession: { output: `${task} result`, ...(first ? { promptGate: firstGate.promise } : {}) },
			});
		},
	);
	try {
		// The second child waits for the first one's slot, as one queued behind its run's concurrency limit does.
		const execution = executor
			.execute(
				"tool-call",
				{
					tasks: [
						{ agent: "worker", task: "first" },
						{ agent: "worker", task: "queued" },
					],
					concurrency: 1,
					artifacts: false,
				},
				new AbortController().signal,
				undefined,
				parent.ctx,
			)
			.catch(() => undefined);
		await firstRunning.promise;
		assert.deepEqual(started, [root], "the second child is still queued");

		// Model fallback replaces the session that launched it before a slot frees.
		parent.retire();
		firstGate.resolve();
		await execution;

		assert.deepEqual(started, [root, root]);
		assert.deepEqual(rejections.stale(), []);
	} finally {
		firstGate.resolve();
		unregisterNotify();
		rejections.stop();
	}
});
