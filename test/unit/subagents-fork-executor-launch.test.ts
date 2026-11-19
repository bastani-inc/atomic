import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { ExtensionContext } from "../../packages/coding-agent/src/index.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentParamsLike,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import * as forkContext from "../../packages/subagents/src/shared/fork-context.js";
import type { SingleResult, SubagentToolResult } from "../../packages/subagents/src/shared/types.js";

/**
 * The `subagent` tool call's id reaches the fork through the executor: a forked child branches at the assistant turn
 * that holds the call that launched it and answers that call as its own, also when several calls of one turn are
 * merged into one burst (#5481).
 */

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const agent: AgentConfig = {
	name: "echo",
	description: "echo test agent",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	systemPrompt: "You are a test agent.",
	source: "project",
	filePath: "/tmp/echo.md",
};

function parentTurn(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "github-copilot",
		model: "claude-opus-5.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

/** Runs the executor against a real parent session and records the session each child is started with. */
function harness(parent: SessionManager) {
	const cwd = parent.getCwd();
	const children = new Map<string, AgentMessage[]>();
	const deps: ExecutorDeps = {
		pi: {
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "parent-session-name",
		} as unknown as ExecutorDeps["pi"],
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
		discoverAgents: () => ({ agents: [agent] }),
		runtime: {
			runSync: async (_parentCwd, _agents, agentName, task, options): Promise<SingleResult> => {
				const label = task.slice(task.lastIndexOf("\n") + 1);
				children.set(label, options.sessionManager?.buildSessionContext().messages ?? []);
				return {
					agent: agentName,
					task,
					status: "ok",
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					finalOutput: `output:${label}`,
				};
			},
		},
	};
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: false,
		ui: { custom: async <T>() => undefined as T },
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: parent,
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
	const executor = createSubagentExecutor(deps);
	return {
		children,
		execute: (id: string, params: SubagentParamsLike): Promise<SubagentToolResult> =>
			executor.execute(id, params, new AbortController().signal, undefined, ctx),
	};
}

async function parentSession(): Promise<SessionManager> {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-fork-launch-"));
	dirs.push(cwd);
	const parent = SessionManager.inMemory(cwd);
	await parent.appendMessage({ role: "user", content: "Fix the bug.", timestamp: Date.now() });
	return parent;
}

/** The tool results a child holds right after the launching turn, by the call they answer. */
function answersAfterLaunchingTurn(messages: AgentMessage[], launchingCallId: string): Map<string, string> {
	const launching = messages.findIndex(
		(message) =>
			message.role === "assistant" &&
			message.content.some((block) => block.type === "toolCall" && block.id === launchingCallId),
	);
	assert.notEqual(launching, -1, "the child holds the turn that launched it");
	const answers = new Map<string, string>();
	for (const message of messages.slice(launching + 1)) {
		assert.equal(message.role, "toolResult", "only the fork's answers follow the launching turn");
		const result = message as ToolResultMessage;
		answers.set(result.toolCallId, (result.content[0] as { text: string }).text);
	}
	return answers;
}

test("attributing interleaved forked children takes linear work and counts only each call's children (#5481)", () => {
	let visits = 0;
	class CallIds extends Array<string | undefined> {}
	// Array operations on this input also produce counted arrays, including scans of a copied prefix.
	CallIds.prototype.filter = new Proxy(Array.prototype.filter, {
		apply(filter, ids: CallIds, args) {
			visits += ids.length;
			return Reflect.apply(filter, ids, args);
		},
	});
	const ids = new CallIds();
	for (let i = 0; i < 128; i++) ids.push(undefined, "sibling");
	const launch = forkContext.forkLaunchOfTasks(ids, "owner");
	for (let i = 0; i < ids.length; i++) {
		assert.deepEqual(launch.childLaunch!(i), {
			toolCallId: i % 2 === 0 ? "owner" : "sibling",
			ordinal: Math.floor(i / 2) + 1,
			count: 128,
		});
	}
	assert.ok(visits <= 10 * ids.length, `${visits} call-ID visits for ${ids.length} tasks`);
});

test("fresh and over-limit launches do not build any fork attribution (#5481)", async () => {
	const { children, execute } = harness(await parentSession());
	const attribution = vi.spyOn(forkContext, "forkLaunchOfTasks");
	try {
		for (const context of ["fresh", "fork"] as const) {
			const result = await execute("many", {
				tasks: [{ agent: "echo", task: "not admitted", count: 8000 }],
				context,
			});
			assert.match(JSON.stringify(result.content), /Too many parallel tasks \(8000 after count expansion\)/);
			assert.equal(children.size, 0);
			assert.equal(attribution.mock.calls.length, 0);
		}
		await execute("fresh", { agent: "echo", task: "fresh", context: "fresh" });
		assert.ok(children.has("fresh"));
		assert.equal(attribution.mock.calls.length, 0);
	} finally {
		attribution.mockRestore();
	}
});

test("a forked child launched by a subagent call forks at the turn holding that call and answers it as its own (#5481)", async () => {
	const parent = await parentSession();
	await parent.appendMessage(
		parentTurn([
			{ type: "thinking", thinking: "Fork a worker, check status.", thinkingSignature: "sig" },
			{ type: "toolCall", id: "call-fork", name: "subagent", arguments: { agent: "echo", task: "A" } },
			{ type: "toolCall", id: "call-status", name: "bash", arguments: { command: "git status" } },
		]),
	);
	// The parent's bash call already returned when the subagent call runs.
	await parent.appendMessage({
		role: "toolResult",
		toolCallId: "call-status",
		toolName: "bash",
		content: [{ type: "text", text: "PARENT_ONLY_STATUS" }],
		isError: false,
		timestamp: Date.now(),
	});
	const { children, execute } = harness(parent);

	await execute("call-fork", { agent: "echo", task: "A", context: "fork" });

	const answers = answersAfterLaunchingTurn(children.get("A")!, "call-fork");
	assert.deepEqual([...answers.keys()], ["call-fork", "call-status"]);
	assert.match(answers.get("call-fork")!, /forked child 1 of 1/);
	assert.doesNotMatch(JSON.stringify(children.get("A")), /PARENT_ONLY_STATUS/);
});

test("children of two subagent calls merged into one burst each answer their own call as theirs (#5481)", async () => {
	const parent = await parentSession();
	await parent.appendMessage(
		parentTurn([
			{ type: "thinking", thinking: "Two workers.", thinkingSignature: "sig" },
			{ type: "toolCall", id: "call-a", name: "subagent", arguments: { agent: "echo", task: "A" } },
			{ type: "toolCall", id: "call-b", name: "subagent", arguments: { agent: "echo", task: "B" } },
		]),
	);
	const { children, execute } = harness(parent);

	await Promise.all([
		execute("call-a", { agent: "echo", task: "A", context: "fork" }),
		execute("call-b", { agent: "echo", task: "B", context: "fork" }),
	]);

	const a = answersAfterLaunchingTurn(children.get("A")!, "call-a");
	const b = answersAfterLaunchingTurn(children.get("B")!, "call-b");
	assert.deepEqual([...a.keys()], ["call-a", "call-b"]);
	assert.deepEqual([...b.keys()], ["call-a", "call-b"]);
	assert.match(a.get("call-a")!, /forked child 1 of 1/);
	assert.match(a.get("call-b")!, /other subagents of the parent session/);
	assert.match(b.get("call-b")!, /forked child 1 of 1/);
	assert.match(b.get("call-a")!, /other subagents of the parent session/);
});
