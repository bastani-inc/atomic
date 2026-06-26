import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import { SUBAGENT_FANOUT_CHILD_ENV } from "../../packages/subagents/src/runs/shared/pi-args.js";
import { stripParentOnlySubagentMessages } from "../../packages/subagents/src/runs/shared/subagent-prompt-runtime.js";
import {
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	registerPromptTemplateDelegationBridge,
} from "../../packages/subagents/src/slash/prompt-template-bridge.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import type { ExecutorDeps, SubagentExecutorRuntimeDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import type { SingleResult, Usage } from "../../packages/subagents/src/shared/types.js";
import type { ExtensionContext } from "../../packages/coding-agent/src/index.js";

type Handler = (data: unknown) => void;

class FakeEvents {
	private readonly handlers = new Map<string, Set<Handler>>();

	on(event: string, handler: Handler): () => void {
		const handlers = this.handlers.get(event) ?? new Set<Handler>();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}

	emit(event: string, data: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(data);
	}
}

function once(events: FakeEvents, event: string): Promise<unknown> {
	return new Promise((resolve) => {
		const unsubscribe = events.on(event, (data) => {
			unsubscribe();
			resolve(data);
		});
	});
}

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	turns: 0,
};

function makeAgent(name: string): AgentConfig {
	return {
		name,
		description: `${name} test agent`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "You are a test agent.",
		source: "project",
		filePath: `/tmp/${name}.md`,
	};
}

function makeState(): ExecutorDeps["state"] {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

function makeContext(cwd: string): ExtensionContext {
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		ui: { custom: async <T>() => undefined as T },
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => "parent-session",
			getLeafId: () => null,
		},
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
}

function makeExecutor(input: {
	cwd: string;
	agents: AgentConfig[];
	runSync: SubagentExecutorRuntimeDeps["runSync"];
}): ReturnType<typeof createSubagentExecutor> {
	const deps: ExecutorDeps = {
		pi: {
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "parent-session-name",
		} as unknown as ExecutorDeps["pi"],
		state: makeState(),
		config: { maxSubagentDepth: 2, parallel: { concurrency: 4, maxTasks: 8 } } as ExecutorDeps["config"],
		asyncByDefault: false,
		tempArtifactsDir: join(input.cwd, "artifacts"),
		getSubagentSessionRoot: () => join(input.cwd, "sessions"),
		expandTilde: (p) => p,
		discoverAgents: () => ({ agents: input.agents }),
		runtime: { runSync: input.runSync },
	};
	return createSubagentExecutor(deps);
}

function result(agent: string, task: string, exitCode = 0, finalOutput = "ok", error?: string): SingleResult {
	return {
		agent,
		task,
		exitCode,
		messages: [],
		usage,
		finalOutput,
		...(error ? { error } : {}),
		artifactPaths: { inputPath: "/tmp/in.md", outputPath: "/tmp/out.md", jsonlPath: "/tmp/run.jsonl", metadataPath: "/tmp/meta.json" },
	};
}

describe("recent upstream subagent syncs", () => {
	test("rebuilds compact delegated tool-call summaries into response messages", async () => {
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => ({
				details: {
					results: [{
						finalOutput: "finished",
						toolCalls: [
							{ text: "write src/output.md", expandedText: "write src/output.md" },
							{ text: "$ bun test", expandedText: "$ bun test" },
						],
					}],
				},
			}),
		});

		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
			requestId: "r-compact-tools",
			agent: "worker",
			task: "do work",
			context: "fresh",
			model: "openai/gpt-5",
			cwd: "/repo",
		});

		const response = await responsePromise as { messages: Array<{ content?: Array<{ type?: string; name?: string; text?: string }> }> };
		const content = response.messages[0]?.content ?? [];
		assert.deepEqual(content.filter((part) => part.type === "toolCall").map((part) => part.name), ["write", "bash"]);
		assert.equal(content.some((part) => part.type === "text" && part.text === "finished"), true);
		bridge.dispose();
	});

	test("preserves live nested subagent history in fanout child context", () => {
		const previous = process.env[SUBAGENT_FANOUT_CHILD_ENV];
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
		try {
			const user = { role: "user", content: "Task" };
			const subagentCall = { role: "assistant", content: [{ type: "toolCall", name: "subagent", input: { agent: "delegate" } }] };
			const subagentResult = { role: "toolResult", toolName: "subagent", content: "OK" };
			const slashTextResult = { role: "custom", customType: "subagent-slash-text-result", content: "Subagent profiles" };

			assert.deepEqual(
				stripParentOnlySubagentMessages([user, subagentCall, subagentResult, slashTextResult]),
				[user, subagentCall, subagentResult],
			);
		} finally {
			if (previous === undefined) delete process.env[SUBAGENT_FANOUT_CHILD_ENV];
			else process.env[SUBAGENT_FANOUT_CHILD_ENV] = previous;
		}
	});

	test("omits provider-rejected chain schema keywords", () => {
		const serialized = JSON.stringify(SubagentParams);
		for (const keyword of ["allOf", "const", "if", "then", "not"]) {
			assert.equal(serialized.includes(`\"${keyword}\"`), false, `schema should omit ${keyword}`);
		}
	});

	test("rejects duplicate concurrent execution calls but allows management", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-upstream-sync-"));
		try {
			const calls: string[] = [];
			const executor = makeExecutor({
				cwd,
				agents: [makeAgent("echo")],
				runSync: async (_parentCwd, _agents, agentName, task) => {
					calls.push(agentName);
					await new Promise((resolve) => setTimeout(resolve, 50));
					return result(agentName, task);
				},
			});
			const ctx = makeContext(cwd);

			const first = executor.execute("first", { agent: "echo", task: "First" }, new AbortController().signal, undefined, ctx);
			const second = await executor.execute("second", { agent: "echo", task: "Duplicate" }, new AbortController().signal, undefined, ctx);
			const status = await executor.execute("status", { action: "status" }, new AbortController().signal, undefined, ctx);
			const firstResult = await first;

			assert.equal(firstResult.isError, undefined);
			assert.equal(second.isError, true);
			assert.match(second.content[0]?.type === "text" ? second.content[0].text : "", /Issue exactly ONE subagent call per turn/);
			assert.equal(status.isError, undefined);
			assert.equal(calls.length, 1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("includes captured output when a foreground single run fails", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-failed-output-"));
		try {
			const executor = makeExecutor({
				cwd,
				agents: [makeAgent("oracle")],
				runSync: async (_parentCwd, _agents, agentName, task) =>
					result(agentName, task, 1, "Oracle review:\n- finding one\n- finding two", "completed without making edits"),
			});

			const output = await executor.execute("failed", { agent: "oracle", task: "Implement" }, new AbortController().signal, undefined, makeContext(cwd));
			const text = output.content[0]?.type === "text" ? output.content[0].text : "";

			assert.equal(output.isError, true);
			assert.match(text, /completed without making edits/);
			assert.match(text, /Output:\nOracle review:\n- finding one\n- finding two/);
			assert.match(text, /Output artifact: \/tmp\/out\.md/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
