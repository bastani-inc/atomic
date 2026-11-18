import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolCall } from "@bastani/atomic-ai";
import { validateToolArguments } from "@bastani/atomic-ai";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { ModelSingleResponse, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindOwnerTaskStore, OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import type { ExtensionContext } from "../../packages/coding-agent/src/index.js";
import { mainComposerHintSegments } from "../../packages/coding-agent/src/modes/interactive/components/main-composer-keys.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { agentPanelRows } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.ts";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { prepareSubagentArguments, SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
	SubagentParamsLike,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import {
	type SingleResult,
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	type SubagentToolResult,
} from "../../packages/subagents/src/shared/types.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
const echo: AgentConfig = {
	name: "echo",
	description: "echo test agent",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	systemPrompt: "You are a test agent.",
	source: "project",
	filePath: "/tmp/echo.md",
};
/** A budget no test waits out: a wait that still honoured it would hang the test until its timeout. */
const LEGACY_FOREGROUND_BUDGET_MS = 600_000;

const cleanups: Array<() => Promise<void> | void> = [];
let previousKeys: ReturnType<typeof getKeybindings>;
let keybindings: KeybindingsManager;
let sessions = 0;
beforeEach(() => {
	initTheme("dark", false);
	previousKeys = getKeybindings();
	keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
});
afterEach(async () => {
	setKeybindings(previousKeys);
	while (cleanups.length > 0) await cleanups.pop()!();
});

/**
 * A parent session with a real task owner and the subagent tool's executor. Each child runs until the test releases
 * it, binds a transcript that takes messages through the parent's Intercom relay, and records what reached it.
 */
function parentWithBlockedChildren() {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-background-launch-"));
	const parentManager = SessionManager.inMemory(cwd);
	const ready = parentManager.appendMessage({ role: "user", content: "parent context", timestamp: Date.now() });
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: `bg-launch-${++sessions}` },
		authorizeLaunch() {},
	});
	const session = {};
	const store = new OwnerTaskStore(host.ownerBinding.supervisor, host.ownerBinding.owner);
	assert.ok(store.connect().ok);
	bindOwnerTaskStore(session, store);
	const release = Promise.withResolvers<void>();
	const delivered: Array<{ to: string; message: string }> = [];
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const events = {
		on(name: string, listener: (payload: unknown) => void) {
			const set = listeners.get(name) ?? new Set();
			set.add(listener);
			listeners.set(name, set);
			return () => set.delete(listener);
		},
		emit(name: string, payload: unknown) {
			for (const listener of [...(listeners.get(name) ?? [])]) listener(payload);
			// The parent's Intercom relay delivers a message typed into a child's transcript to that child.
			if (name === SUBAGENT_RESULT_INTERCOM_EVENT) {
				const request = payload as { to: string; message: string; requestId: string };
				delivered.push({ to: request.to, message: request.message });
				events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: request.requestId, delivered: true });
			}
		},
	};
	const started: string[] = [];
	const runSync: SubagentExecutorRuntimeDeps["runSync"] = async (_cwd, _agents, _agent, task, options) => {
		started.push(task);
		options.taskExecution?.bindTranscript?.({ getSessionId: () => `child-${task}`, getEntries: () => [] });
		await release.promise;
		return { agent: "echo", task, status: "ok", messages: [], usage, finalOutput: `output:${task}` } as SingleResult;
	};
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: false,
		ui: {},
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: parentManager,
		isIdle: () => true,
		isProjectTrusted: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		getAgentTaskHost: () => host,
	} as unknown as ExtensionContext;
	const executor = createSubagentExecutor({
		pi: { events, getSessionName: () => "parent" } as unknown as ExecutorDeps["pi"],
		state: {
			baseCwd: "",
			currentSessionId: null,
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
		},
		config: { parallel: { concurrency: 4, maxTasks: 50 } } as ExecutorDeps["config"],
		tempArtifactsDir: join(cwd, "artifacts"),
		getSubagentSessionRoot: () => join(cwd, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: async () => ({ agents: [echo] }),
		runtime: { runSync },
	});
	cleanups.push(async () => {
		release.resolve();
		store.dispose();
		await host.close("session-close");
		rmSync(cwd, { recursive: true, force: true });
	});
	return {
		host,
		session,
		store,
		started,
		delivered,
		release: () => release.resolve(),
		/** A model's call: its arguments are prepared and validated against the tool's schema, as the agent loop does. */
		modelCall(id: string, args: ToolCall["arguments"], signal = new AbortController().signal) {
			const tool = { name: "subagent", description: "", parameters: SubagentParams } as unknown as Tool;
			const call: ToolCall = { type: "toolCall", id, name: "subagent", arguments: args };
			const prepared: ToolCall = {
				...call,
				arguments: prepareSubagentArguments(call.arguments) as ToolCall["arguments"],
			};
			const params = validateToolArguments(tool, prepared) as SubagentParamsLike;
			return ready.then(() => executor.execute(id, params, signal, undefined, ctx));
		},
		/** A call from an extension or SDK host, which reaches the executor without the model's schema. */
		directCall(id: string, params: SubagentParamsLike, signal = new AbortController().signal) {
			return ready.then(() => executor.execute(id, params, signal, undefined, ctx));
		},
	};
}

function text(result: SubagentToolResult): string {
	return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

function admitted(result: SubagentToolResult): Extract<ModelSingleResponse, { kind: "admitted" }> {
	const response = result.details?.taskResponse;
	assert.equal(response?.kind, "admitted", text(result));
	assert.ok(response?.kind === "admitted");
	return response;
}

test("a launch that still asks to wait in the foreground runs in the background and says so", async () => {
	const parent = parentWithBlockedChildren();
	for (const [id, call] of [
		[
			"model",
			() =>
				parent.modelCall("model", {
					agent: "echo",
					task: "model",
					wait: { kind: "foreground", budgetMs: LEGACY_FOREGROUND_BUDGET_MS },
				}),
		],
		[
			"direct",
			() =>
				parent.directCall("direct", {
					agent: "echo",
					task: "direct",
					wait: { kind: "foreground", budgetMs: LEGACY_FOREGROUND_BUDGET_MS },
				} as SubagentParamsLike),
		],
	] as const) {
		// The child runs until the test releases it: the call returns while it is still running.
		const result = await call();
		const observation = admitted(result).observation;
		assert.equal(observation.kind, "yielded", `${id}: the launch returns at once`);
		assert.match(text(result), /^Note: subagents always run in the background\b.*\n/, `${id}: one-line note first`);
		assert.equal(
			parent.host.taskRecords().find((task) => task.ref.taskId === observation.taskId)?.execution.kind,
			"running",
		);
	}
	const plain = await parent.modelCall("plain", { agent: "echo", task: "plain" });
	assert.doesNotMatch(text(plain), /^Note:/, "a launch that asks for nothing gets no note");
});

test("a just-launched subagent is listed below the prompt and in /tasks, and takes a message typed into its chat", async () => {
	const parent = parentWithBlockedChildren();
	const result = await parent.modelCall("launch", {
		agent: "echo",
		task: "listed",
		wait: { kind: "foreground", budgetMs: LEGACY_FOREGROUND_BUDGET_MS },
	});
	const taskId = admitted(result).observation.taskId as TaskId;
	parent.store.drain();
	const source = ownerTaskViewSource(parent.store);
	assert.deepEqual(
		source.backgroundTasks.map((task) => task.ref.taskId),
		[taskId],
		"/tasks lists the running child",
	);
	assert.deepEqual(
		agentPanelRows(parent.session).map((row) => row.id),
		[`task:${taskId}`],
		"the panel below the prompt has a row for it",
	);
	assert.equal(mainComposerHintSegments(keybindings, parent.session)[0], "↓ 1 agent");
	assert.ok(source.sendTaskMessage, "its chat takes messages");
	await source.sendTaskMessage(taskId, "also check the tests");
	assert.equal(parent.delivered.length, 1);
	assert.equal(parent.delivered[0]?.message, "also check the tests");
	assert.match(parent.delivered[0]?.to ?? "", /^subagent-echo-/, "the message goes to the child's own Intercom name");
});

test.each(["while it waits", "before it waits"] as const)(
	"Esc ends an explicit wait for a running subagent at once and leaves the child running (%s)",
	async (when) => {
		const parent = parentWithBlockedChildren();
		const launch = await parent.modelCall("launch", { agent: "echo", task: "waited" });
		const taskId = admitted(launch).observation.taskId;
		const esc = new AbortController();
		if (when === "before it waits") esc.abort();
		const waiting = parent.modelCall(
			"wait",
			{ action: "wait", id: taskId, budgetMs: LEGACY_FOREGROUND_BUDGET_MS },
			esc.signal,
		);
		if (when === "while it waits") {
			parent.store.drain();
			esc.abort();
		}
		// The child is still blocked: only the abort can end this wait before its budget.
		const result = await waiting;
		assert.match(text(result), new RegExp(`Stopped waiting for ${taskId}\\. It keeps running in the background`));
		assert.notEqual(result.isError, true);
		assert.equal(parent.host.taskRecords().find((task) => task.ref.taskId === taskId)?.execution.kind, "running");
		parent.release();
		const settled = await parent.host.waitForTask(taskId as TaskId);
		assert.ok(settled.ok && settled.value.kind === "settled", "the child still finishes on its own");
	},
);
