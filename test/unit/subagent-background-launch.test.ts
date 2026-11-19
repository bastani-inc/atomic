import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import registerSubagentNotify from "../../packages/subagents/src/runs/foreground/notify.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import type { SubagentState } from "../../packages/subagents/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

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
		currentSessionId: "parent-session",
		subagentInProgress: false,
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
}

function ownerContext(root: string, id: string): ExtensionContext {
	return {
		cwd: root,
		mode: "tui",
		hasUI: false,
		ui: {},
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => join(root, `${id}.jsonl`),
			getSessionId: () => `session-${id}`,
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
}

interface Harness {
	readonly execute: ReturnType<typeof createSubagentExecutor>["execute"];
	readonly emittedNotifications: string[];
	readonly unregisterNotify: () => void;
}

function harness(root: string, emitter: EventEmitter, gates: readonly Promise<void>[]): Harness {
	const bus = eventBus(emitter);
	const emittedNotifications: string[] = [];
	let nextGate = 0;
	const pi = {
		events: bus,
		getSessionName: () => "parent",
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
				const gate = gates[nextGate++] ?? Promise.resolve();

				return runSync(cwd, agents, agentName, task, {
					...options,
					testSession: { output: `${task} result`, promptGate: gate, abortResolvesPrompt: true },
				});
			},
		},
	});
	return {
		execute: execute.execute,
		emittedNotifications,

		unregisterNotify,
	};
}

// RFC PR #2884: the public tool returns an observation, not an execution result.
test("task-bound public single launch yields immediately and owner wait observes the original child", async () => {
	const root = makeTempDirectory("task-public-");
	roots.push(root);
	const ctx = ownerContext(root, "task-single");
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: ctx.sessionManager.getSessionId() },
		authorizeLaunch() {},
	});
	ctx.getAgentTaskHost = () => host;
	const gate = Promise.withResolvers<void>();
	const h = harness(root, new EventEmitter(), [gate.promise]);
	try {
		const response = await h.execute(
			"public-task",
			{ agent: "worker", task: " raw task ", progress: false, artifacts: false },
			new AbortController().signal,
			undefined,
			ctx,
		);
		const dto = response.details?.taskResponse;
		assert.equal(dto?.kind, "admitted");
		assert.ok(dto && dto.kind === "admitted");
		assert.equal(dto.observation.kind, "yielded");
		assert.ok(dto.observation.kind === "yielded");
		assert.equal(dto.observation.reason, "default-background");
		const pending = await h.execute(
			"wait-live",
			{ action: "wait", id: dto.observation.taskId, budgetMs: 0 },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.match(pending.content[0]?.type === "text" ? pending.content[0].text : "", /elapsed/);
		gate.resolve();
		const terminal = await host.waitForTask(dto.observation.taskId);
		assert.ok(terminal.ok && terminal.value.kind === "settled");
		assert.equal(terminal.value.result.kind, "completed");
		assert.equal(h.emittedNotifications.length, 0);
	} finally {
		gate.resolve();
		await host.close("session-close");
		h.unregisterNotify();
	}
});

// RFC PR #2884: independent parallel launch admits queued slots without dispatching them.
test("task-bound parallel launch keeps ordered duplicate slots queued under concurrency until owner close", async () => {
	const root = makeTempDirectory("task-parallel-");
	roots.push(root);
	const ctx = ownerContext(root, "task-parallel");
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: ctx.sessionManager.getSessionId() },
		authorizeLaunch() {},
	});
	ctx.getAgentTaskHost = () => host;
	const gate = Promise.withResolvers<void>();
	const h = harness(
		root,
		new EventEmitter(),
		Array.from({ length: 6 }, () => gate.promise),
	);
	try {
		const response = await h.execute(
			"parallel-task",
			{
				tasks: Array.from({ length: 6 }, () => ({ agent: "worker", task: " x ", progress: false, output: false })),
				artifacts: false,
			},
			new AbortController().signal,
			undefined,
			ctx,
		);
		const dto = response.details?.taskResponse;
		assert.ok(dto?.kind === "parallel");
		assert.deepEqual(
			dto.slots.map((slot) => slot.ordinal),
			[0, 1, 2, 3, 4, 5],
		);
		assert.ok(
			dto.slots.every(
				({ outcome }) =>
					outcome.kind === "admitted" &&
					outcome.observation.kind === "yielded" &&
					outcome.observation.reason === "default-background",
			),
		);
		const watched = host.watchOwnerTasks();
		assert.ok(watched.ok);
		assert.deepEqual(
			watched.value.snapshot.tasks.map((task) => task.execution.kind),
			["running", "running", "running", "running", "queued", "queued"],
		);
		assert.equal(new Set(watched.value.snapshot.tasks.map((task) => task.ref.taskId)).size, 6);
		watched.value.dispose();
		await host.close("session-close");
		assert.equal(h.emittedNotifications.length, 0);
	} finally {
		gate.resolve();
		await host.close("session-close");
		h.unregisterNotify();
	}
});
