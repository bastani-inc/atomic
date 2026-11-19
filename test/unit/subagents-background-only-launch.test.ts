import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@bastani/atomic-agent-core";
import type { Tool, ToolCall } from "@bastani/atomic-ai";
import { validateToolArguments } from "@bastani/atomic-ai";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
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
import { createHarness, getMessageText } from "../../packages/coding-agent/test/suite/harness.js";
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
function parentWithBlockedChildren(options: { sessionManager?: SessionManager; taskHost?: false } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-background-launch-"));
	const parentManager = options.sessionManager ?? SessionManager.inMemory(cwd);
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
		...(options.taskHost === false ? {} : { getAgentTaskHost: () => host }),
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
		/**
		 * A model's call, as a session runs it: the assistant message that issued it is saved first, then its arguments
		 * are prepared and validated against the tool's schema. A call that fails validation never executes.
		 */
		async modelCall(id: string, args: ToolCall["arguments"], signal = new AbortController().signal) {
			await ready;
			const call = fauxToolCall("subagent", args, { id });
			await parentManager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
			const tool = { name: "subagent", description: "", parameters: SubagentParams } as unknown as Tool;
			const prepared: ToolCall = {
				...call,
				arguments: prepareSubagentArguments(call.arguments) as ToolCall["arguments"],
			};
			const params = validateToolArguments(tool, prepared) as SubagentParamsLike;
			return executor.execute(id, params, signal, undefined, ctx);
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

test("a launch that asked to wait in the foreground but failed validation leaves no note for the same launch after it", async () => {
	const parent = parentWithBlockedChildren();
	await assert.rejects(
		parent.modelCall("invalid", {
			agent: "echo",
			task: "same",
			wait: { kind: "foreground", budgetMs: LEGACY_FOREGROUND_BUDGET_MS },
			notAField: true,
		}),
		/notAField|additional/i,
	);
	const next = await parent.modelCall("next", { agent: "echo", task: "same" });
	assert.equal(admitted(next).observation.kind, "yielded");
	assert.doesNotMatch(text(next), /^Note:/, "only the call that asked for the foreground gets the note");
});

test("through the agent loop, the note goes to exactly the call that asked to wait in the foreground", async () => {
	const sessionManager = SessionManager.inMemory();
	const parent = parentWithBlockedChildren({ sessionManager });
	const subagent: AgentTool = {
		name: "subagent",
		label: "Subagent",
		description: "Launch a subagent",
		parameters: SubagentParams,
		prepareArguments: prepareSubagentArguments,
		execute: (id, params, signal) => parent.directCall(id, params as SubagentParamsLike, signal),
	};
	const harness = await createHarness({ sessionManager, tools: [subagent] });
	cleanups.push(() => harness.cleanup());
	const launch = (args: ToolCall["arguments"]) =>
		fauxAssistantMessage(fauxToolCall("subagent", args), { stopReason: "toolUse" });
	const foreground = { kind: "foreground", budgetMs: LEGACY_FOREGROUND_BUDGET_MS };
	harness.setResponses([
		launch({ agent: "echo", task: "same", wait: foreground, notAField: true }),
		launch({ agent: "echo", task: "same" }),
		launch({ agent: "echo", task: "asked", wait: foreground }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("Launch them");
	const results = harness.session.messages.filter((message) => message.role === "toolResult");
	assert.equal(results.length, 3);
	assert.equal(results[0]?.role === "toolResult" && results[0].isError, true, "the invalid call never runs");
	assert.doesNotMatch(getMessageText(results[1]), /Note: subagents always run in the background/);
	assert.match(getMessageText(results[2]), /^Note: subagents always run in the background\b/);
});

test("through the agent loop, a call that asks to wait and a sibling that does not launch apart, so a field they do not share fails neither (#5686)", async () => {
	const sessionManager = SessionManager.inMemory();
	const parent = parentWithBlockedChildren({ sessionManager });
	const subagent: AgentTool = {
		name: "subagent",
		label: "Subagent",
		description: "Launch a subagent",
		parameters: SubagentParams,
		prepareArguments: prepareSubagentArguments,
		execute: (id, params, signal) => parent.directCall(id, params as SubagentParamsLike, signal),
	};
	const harness = await createHarness({ sessionManager, tools: [subagent] });
	cleanups.push(() => harness.cleanup());
	const foreground = { kind: "foreground", budgetMs: LEGACY_FOREGROUND_BUDGET_MS };
	// One assistant message issues both calls, so they reach the subagent tool as one burst.
	harness.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("subagent", { agent: "echo", task: "with-wait", concurrency: 1, wait: foreground }),
				fauxToolCall("subagent", { agent: "echo", task: "without-wait" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("Launch them");
	const results = harness.session.messages.filter((message) => message.role === "toolResult");
	assert.equal(results.length, 2);
	const texts = results.map((message) => getMessageText(message));
	assert.deepEqual(
		results.map((message) => message.role === "toolResult" && message.isError),
		[false, false],
		texts.join(" | "),
	);
	assert.match(texts[0]!, /^Note: subagents always run in the background\b/);
	assert.doesNotMatch(texts[1]!, /Note: subagents always run in the background/);
	const deadline = Date.now() + 10_000;
	while (parent.started.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual([...parent.started].sort(), ["with-wait", "without-wait"]);
});

test("through the agent loop, sibling calls that can merge keep their shared concurrency of one when only one passes a wait (#5686)", async () => {
	const sessionManager = SessionManager.inMemory();
	const parent = parentWithBlockedChildren({ sessionManager });
	const subagent: AgentTool = {
		name: "subagent",
		label: "Subagent",
		description: "Launch a subagent",
		parameters: SubagentParams,
		prepareArguments: prepareSubagentArguments,
		execute: (id, params, signal) => parent.directCall(id, params as SubagentParamsLike, signal),
	};
	const harness = await createHarness({ sessionManager, tools: [subagent] });
	cleanups.push(() => harness.cleanup());
	harness.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("subagent", { agent: "echo", task: "A", concurrency: 1, wait: { kind: "background" } }),
				fauxToolCall("subagent", { agent: "echo", task: "B", concurrency: 1 }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("Launch them");
	const results = harness.session.messages.filter((message) => message.role === "toolResult");
	assert.equal(results.length, 2);
	assert.ok(
		results.every((message) => message.role === "toolResult" && !message.isError),
		results.map((message) => getMessageText(message)).join(" | "),
	);
	const deadline = Date.now() + 500;
	while (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(parent.started, ["A"], "a shared concurrency of one starts B only once A ends");
	parent.release();
	await vi.waitFor(() => assert.deepEqual(parent.started, ["A", "B"]));
});

test("without a task host, a launch that asks to wait in the foreground still waits for its child, so it gets no note", async () => {
	const parent = parentWithBlockedChildren({ taskHost: false });
	parent.release();
	const result = await parent.modelCall("direct-run", {
		agent: "echo",
		task: "direct",
		wait: { kind: "foreground", budgetMs: LEGACY_FOREGROUND_BUDGET_MS },
	});
	assert.equal(result.details?.taskResponse, undefined, "the child ran directly, not as a task");
	assert.match(text(result), /Children: 1 completed/, "the call returns the finished run");
	assert.doesNotMatch(text(result), /^Note:/);
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
			// Esc comes once the wait is registered, so only the abort listener can end it.
			await vi.waitFor(() => assert.equal(parent.host.hasActiveTaskWaits, true, "the wait registered before Esc"));
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
