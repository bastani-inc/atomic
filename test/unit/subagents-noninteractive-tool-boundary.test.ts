import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import type { ExecutorDeps, SubagentExecutorRuntimeDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@bastani/atomic";
import registerSubagentExtension from "../../packages/subagents/src/extension/index.js";
import registerFanoutChildSubagentExtension from "../../packages/subagents/src/extension/fanout-child.js";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../../packages/subagents/src/runs/shared/pi-args.js";
import {
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	type SingleResult,
} from "../../packages/subagents/src/shared/types.js";
import { registerSlashSubagentBridge } from "../../packages/subagents/src/slash/slash-bridge.js";
import { createProgrammaticSubagentToolEntrypoint } from "../../packages/subagents/src/extension/programmatic-tool.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";

type EventHandler = (data: unknown) => void;

class FakeEvents {
	private readonly handlers = new Map<string, Set<EventHandler>>();

	on(event: string, handler: EventHandler): () => void {
		const handlers = this.handlers.get(event) ?? new Set<EventHandler>();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}

	emit(event: string, data: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(data);
	}
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function makeAgent(name: string): AgentConfig {
	return {
		name,
		description: name,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "Test agent",
		source: "project",
		filePath: `/tmp/${name}.md`,
	};
}

function makeResult(agent: string, task: string, finalOutput = `${agent} complete`): SingleResult {
	return { agent, task, exitCode: 0, messages: [], usage, finalOutput };
}

function makeContext(cwd: string, onCustom: () => never): ExtensionContext {
	return {
		cwd,
		mode: "tui",
		hasUI: true,
		ui: { custom: async () => onCustom(), setToolsExpanded: () => {}, setWidget: () => {} },
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

function makeExecutor(
	cwd: string,
	agents: AgentConfig[],
	runtime: Partial<SubagentExecutorRuntimeDeps>,
	asyncByDefault = false,
) {
	const state: ExecutorDeps["state"] = {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		subagentInProgress: false,
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
	return createSubagentExecutor({
		pi: { events: { on: () => () => {}, emit: () => {} }, getSessionName: () => "parent" } as unknown as ExecutorDeps["pi"],
		state,
		config: { asyncByDefault, maxSubagentDepth: 2, parallel: { concurrency: 4, maxTasks: 8 } },
		asyncByDefault,
		tempArtifactsDir: join(cwd, "artifacts"),
		getSubagentSessionRoot: () => join(cwd, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents }),
		runtime,
	});
}

describe("programmatic subagent tool boundary", () => {
	test("accepts supported output limits, rejects clarification, and normalizes execution", async () => {
		assert.equal(Value.Check(SubagentParams, {
			agent: "worker",
			task: "fix it",
			maxOutput: { bytes: 1024, lines: 100 },
		}), true);
		assert.equal(Value.Check(SubagentParams, {
			agent: "worker",
			task: "fix it",
			clarify: true,
		}), false);

		let received: Record<string, unknown> | undefined;
		const entrypoint = createProgrammaticSubagentToolEntrypoint(async (_id, params) => {
			received = params as unknown as Record<string, unknown>;
			return { content: [{ type: "text", text: "ok" }], details: { mode: "single", results: [] } };
		});
		await entrypoint.execute(
			"single",
			{ agent: "worker", task: "fix it" },
			new AbortController().signal,
			undefined,
			{} as never,
		);

		assert.deepEqual(received, { agent: "worker", task: "fix it", clarify: false });
	});
	test("foreground single execution stays non-interactive", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-tool-single-"));
		try {
			let customCalls = 0;
			const runCalls: Array<{ agent: string; task: string }> = [];
			const executor = makeExecutor(cwd, [makeAgent("worker")], {
				runSync: async (_cwd, _agents, agent, task) => {
					runCalls.push({ agent, task });
					return makeResult(agent, task);
				},
			});
			const entrypoint = createProgrammaticSubagentToolEntrypoint(executor.execute);

			const result = await entrypoint.execute(
				"single",
				{ agent: "worker", task: "fix it" },
				new AbortController().signal,
				undefined,
				makeContext(cwd, () => { customCalls += 1; throw new Error("unexpected clarification UI"); }),
			);

			assert.equal(result.isError, undefined);
			assert.deepEqual(runCalls, [{ agent: "worker", task: "fix it" }]);
			assert.equal(customCalls, 0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("asyncByDefault dispatches omitted async in the background without UI", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-tool-async-default-"));
		try {
			let customCalls = 0;
			let foregroundCalls = 0;
			const backgroundCalls: Array<{ agent: string; task: string }> = [];
			const executor = makeExecutor(cwd, [makeAgent("worker")], {
				isAsyncAvailable: () => true,
				executeAsyncSingle: (_id, params) => {
					assert.ok(typeof params.task === "string");
					backgroundCalls.push({ agent: params.agent, task: params.task });
					return { content: [{ type: "text", text: "background started" }], details: { mode: "single", results: [] } };
				},
				runSync: async (_cwd, _agents, agent, task) => {
					foregroundCalls += 1;
					return makeResult(agent, task);
				},
			}, true);
			const entrypoint = createProgrammaticSubagentToolEntrypoint(executor.execute);

			const result = await entrypoint.execute(
				"async-default",
				{ agent: "worker", task: "fix it" },
				new AbortController().signal,
				undefined,
				makeContext(cwd, () => { customCalls += 1; throw new Error("unexpected clarification UI"); }),
			);

			assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "background started");
			assert.deepEqual(backgroundCalls, [{ agent: "worker", task: "fix it" }]);
			assert.equal(foregroundCalls, 0);
			assert.equal(customCalls, 0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("authorized fanout child registers the same non-interactive boundary", async () => {
		const previousChild = process.env[SUBAGENT_CHILD_ENV];
		const previousFanout = process.env[SUBAGENT_FANOUT_CHILD_ENV];
		let registered: ToolDefinition | undefined;
		try {
			process.env[SUBAGENT_CHILD_ENV] = "1";
			process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
			const pi = {
				registerTool: (tool: ToolDefinition) => { registered = tool; },
				events: { on: () => () => {}, emit: () => {} },
				getSessionName: () => "fanout-child",
			} as unknown as ExtensionAPI;
			registerFanoutChildSubagentExtension(pi);

			assert.ok(registered);
			assert.equal(Object.hasOwn((registered.parameters as typeof SubagentParams).properties, "clarify"), false);

			let customCalls = 0;
			const result = await registered.execute(
				"fanout-chain",
				{ chain: [{ agent: "debugger" }] },
				new AbortController().signal,
				undefined,
				makeContext(process.cwd(), () => { customCalls += 1; throw new Error("unexpected clarification UI"); }),
			);
			assert.equal(customCalls, 0);
			assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /First step in chain must have a task/);
		} finally {
			if (previousChild === undefined) delete process.env[SUBAGENT_CHILD_ENV];
			else process.env[SUBAGENT_CHILD_ENV] = previousChild;
			if (previousFanout === undefined) delete process.env[SUBAGENT_FANOUT_CHILD_ENV];
			else process.env[SUBAGENT_FANOUT_CHILD_ENV] = previousFanout;
		}
	});

	test("foreground sequential chain stays non-interactive and hands {previous} to the next step", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-tool-chain-"));
		try {
			let customCalls = 0;
			const runCalls: Array<{ agent: string; task: string }> = [];
			const executor = makeExecutor(cwd, [makeAgent("scout"), makeAgent("worker")], {
				runSync: async (_cwd, _agents, agent, task) => {
					runCalls.push({ agent, task });
					return makeResult(agent, task, agent === "scout" ? "handoff payload" : "implemented");
				},
			});
			const entrypoint = createProgrammaticSubagentToolEntrypoint(executor.execute);

			const result = await entrypoint.execute(
				"chain",
				{
					chain: [
						{ agent: "scout", task: "inspect the failure" },
						{ agent: "worker", task: "implement from {previous}" },
					],
				},
				new AbortController().signal,
				undefined,
				makeContext(cwd, () => { customCalls += 1; throw new Error("unexpected clarification UI"); }),
			);

			assert.equal(result.isError, undefined);
			assert.equal(customCalls, 0);
			assert.deepEqual(runCalls.map((call) => call.agent), ["scout", "worker"]);
			assert.equal(runCalls[1]?.task, "implement from handoff payload");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("foreground parallel execution stays non-interactive", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-tool-parallel-"));
		try {
			let customCalls = 0;
			const runCalls: Array<{ agent: string; task: string }> = [];
			const executor = makeExecutor(cwd, [makeAgent("alpha"), makeAgent("beta")], {
				runSync: async (_cwd, _agents, agent, task) => {
					runCalls.push({ agent, task });
					return makeResult(agent, task);
				},
			});
			const entrypoint = createProgrammaticSubagentToolEntrypoint(executor.execute);

			const result = await entrypoint.execute(
				"parallel",
				{
					tasks: [
						{ agent: "alpha", task: "inspect alpha" },
						{ agent: "beta", task: "inspect beta" },
					],
				},
				new AbortController().signal,
				undefined,
				makeContext(cwd, () => { customCalls += 1; throw new Error("unexpected clarification UI"); }),
			);

			assert.equal(result.isError, undefined);
			assert.equal(customCalls, 0);
			assert.deepEqual(runCalls.map((call) => call.agent).sort(), ["alpha", "beta"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("async single, parallel, and sequential-chain launches stay non-interactive", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-tool-async-"));
		try {
			let customCalls = 0;
			const asyncSingle: Array<{ agent: string; task: string }> = [];
			const asyncChains: Array<{ mode?: string; chainLength: number }> = [];
			const executor = makeExecutor(cwd, [makeAgent("alpha"), makeAgent("beta")], {
				isAsyncAvailable: () => true,
				executeAsyncSingle: (_id, params) => {
					asyncSingle.push({ agent: params.agent, task: params.task ?? "" });
					return { content: [{ type: "text", text: "single started" }], details: { mode: "single", results: [] } };
				},
				executeAsyncChain: (_id, params) => {
					asyncChains.push({ mode: params.resultMode, chainLength: params.chain.length });
					return { content: [{ type: "text", text: "chain started" }], details: { mode: params.resultMode ?? "chain", results: [] } };
				},
			});
			const entrypoint = createProgrammaticSubagentToolEntrypoint(executor.execute);
			const ctx = makeContext(cwd, () => { customCalls += 1; throw new Error("unexpected clarification UI"); });
			const signal = new AbortController().signal;

			await entrypoint.execute("async-single", { agent: "alpha", task: "one", async: true }, signal, undefined, ctx);
			await entrypoint.execute("async-parallel", {
				tasks: [{ agent: "alpha", task: "one" }, { agent: "beta", task: "two" }],
				async: true,
			}, signal, undefined, ctx);
			await entrypoint.execute("async-chain", {
				chain: [
					{ agent: "alpha", task: "first" },
					{ agent: "beta", task: "continue from {previous}" },
				],
				async: true,
			}, signal, undefined, ctx);

			assert.equal(customCalls, 0);
			assert.deepEqual(asyncSingle, [{ agent: "alpha", task: "one" }]);
			assert.deepEqual(asyncChains, [
				{ mode: "parallel", chainLength: 1 },
				{ mode: undefined, chainLength: 2 },
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("parent registration exposes the non-interactive tool and preserves slash commands", async () => {
		const previousChild = process.env[SUBAGENT_CHILD_ENV];
		const previousFanout = process.env[SUBAGENT_FANOUT_CHILD_ENV];
		let registered: ToolDefinition | undefined;
		const commands: string[] = [];
		const handlers = new Map<string, Array<() => void>>();
		try {
			delete process.env[SUBAGENT_CHILD_ENV];
			delete process.env[SUBAGENT_FANOUT_CHILD_ENV];
			const pi = {
				registerTool: (tool: ToolDefinition) => { registered = tool; },
				registerCommand: (name: string) => { commands.push(name); },
				registerMessageRenderer: () => {},
				sendMessage: () => {},
				on: (event: string, handler: () => void) => {
					const eventHandlers = handlers.get(event) ?? [];
					eventHandlers.push(handler);
					handlers.set(event, eventHandlers);
				},
				events: { on: () => () => {}, emit: () => {} },
				getSessionName: () => "parent",
			} as unknown as ExtensionAPI;
			registerSubagentExtension(pi);

			assert.ok(registered);

			let customCalls = 0;
			const result = await registered.execute(
				"parent-chain",
				{ chain: [{ agent: "debugger" }] },
				new AbortController().signal,
				undefined,
				makeContext(process.cwd(), () => { customCalls += 1; throw new Error("unexpected clarification UI"); }),
			);
			assert.equal(customCalls, 0);
			assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /First step in chain must have a task/);

			assert.deepEqual(commands.filter((name) => ["run", "chain", "parallel", "run-chain"].includes(name)).sort(), ["chain", "parallel", "run", "run-chain"]);

			const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
			for (const args of [
				{ agent: "worker", async: true },
				{ tasks: [{ agent: "worker", task: "one" }], async: true },
				{ chain: [{ agent: "worker", task: "one" }], async: true },
			]) {
				const component = registered.renderCall?.(args as never, theme, {} as never);
				assert.match(component?.render(120).join("\n") ?? "", /\[async\]/);
			}
		} finally {
			for (const shutdown of handlers.get("session_shutdown") ?? []) shutdown();
			if (previousChild === undefined) delete process.env[SUBAGENT_CHILD_ENV];
			else process.env[SUBAGENT_CHILD_ENV] = previousChild;
			if (previousFanout === undefined) delete process.env[SUBAGENT_FANOUT_CHILD_ENV];
			else process.env[SUBAGENT_FANOUT_CHILD_ENV] = previousFanout;
		}
	});

	test("slash bridge dispatch remains separate and forwards its parameters unchanged", async () => {
		const events = new FakeEvents();
		let received: Record<string, unknown> | undefined;
		const response = new Promise<void>((resolve) => {
			const unsubscribe = events.on(SLASH_SUBAGENT_RESPONSE_EVENT, () => { unsubscribe(); resolve(); });
		});
		const bridge = registerSlashSubagentBridge({
			events,
			getContext: () => makeContext("/tmp", () => { throw new Error("not used"); }),
			execute: async (_id, params) => {
				received = params as unknown as Record<string, unknown>;
				return { content: [{ type: "text", text: "done" }], details: { mode: "chain", results: [] } };
			},
		});

		events.emit(SLASH_SUBAGENT_REQUEST_EVENT, {
			requestId: "slash-chain",
			params: { chain: [{ agent: "worker", task: "one" }], clarify: true },
		});
		await response;

		assert.deepEqual(received, { chain: [{ agent: "worker", task: "one" }], clarify: true });
		bridge.dispose();
	});

});
