import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@bastani/atomic";
import { Value } from "typebox/value";
import { describe, test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import registerFanoutChildSubagentExtension from "../../packages/subagents/src/extension/fanout-child.js";
import registerSubagentExtension from "../../packages/subagents/src/extension/index.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import {
	type SingleResult,
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	type SubagentToolResult,
} from "../../packages/subagents/src/shared/types.js";
import { registerSlashSubagentBridge } from "../../packages/subagents/src/slash/slash-bridge.js";

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

function makeAgent(name: string, source: AgentConfig["source"] = "project"): AgentConfig {
	return {
		name,
		description: name,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "Test agent",
		source,
		filePath: `/tmp/${name}.md`,
	};
}

function makeResult(agent: string, task: string, finalOutput = `${agent} complete`): SingleResult {
	return { agent, task, status: "ok", messages: [], usage, finalOutput };
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
		pi: {
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "parent",
		} as unknown as ExecutorDeps["pi"],
		state,
		config: { asyncByDefault, maxSubagentDepth: 2, parallel: { concurrency: 4, maxTasks: 50 } },
		asyncByDefault,
		tempArtifactsDir: join(cwd, "artifacts"),
		getSubagentSessionRoot: () => join(cwd, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents }),
		runtime,
	});
}

test("list action returns the available agent catalogue", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-list-"));
	try {
		const executor = makeExecutor(cwd, [makeAgent("codebase-analyzer", "builtin")], {});
		const result = await executor.execute(
			"list",
			{ action: "list" },
			new AbortController().signal,
			undefined,
			makeContext(cwd, () => {
				throw new Error("unexpected UI prompt");
			}),
		);
		const text = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		assert.match(text, /Executable agents:/);
		assert.match(text, /codebase-analyzer/);
		assert.doesNotMatch(text, /No in-process subagents\./);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("root single reads are schema-valid, cwd-correct, and identical in foreground and async modes", async () => {
	const parentCwd = mkdtempSync(join(tmpdir(), "atomic-subagent-root-reads-"));
	try {
		const childCwd = join(parentCwd, "child");
		const absoluteRead = join(parentCwd, "absolute.md");
		const reads = ["docs/a.md", "../shared.md", absoluteRead];
		assert.equal(Value.Check(SubagentParams, { agent: "worker", task: "fix it", cwd: "child", reads }), true);
		assert.equal(Value.Check(SubagentParams, { agent: "worker", task: "fix it", reads: true }), false);
		const captured: string[] = [];
		const foreground = makeExecutor(parentCwd, [makeAgent("worker")], {
			runSync: async (_cwd, _agents, agent, task) => {
				captured.push(task);
				return makeResult(agent, task);
			},
		});
		const background = makeExecutor(
			parentCwd,
			[makeAgent("worker")],
			{
				isAsyncAvailable: () => true,
				executeAsyncSingle: (_id, params) => {
					captured.push(params.task ?? "");
					return { content: [{ type: "text", text: "launched" }], details: { mode: "single", results: [] } };
				},
			},
			true,
		);
		const context = makeContext(parentCwd, () => {
			throw new Error("unexpected prompt");
		});
		await foreground.execute(
			"fg",
			{ agent: "worker", task: "fix it", cwd: "child", reads },
			new AbortController().signal,
			undefined,
			context,
		);
		await background.execute(
			"bg",
			{ agent: "worker", task: "fix it", cwd: "child", reads },
			new AbortController().signal,
			undefined,
			context,
		);
		const expected = `[Read from: ${join(childCwd, "docs/a.md")}, ${join(parentCwd, "shared.md")}, ${absoluteRead}]\n\nfix it`;
		assert.deepEqual(captured, [expected, expected]);
		await foreground.execute(
			"disabled",
			{ agent: "worker", task: "plain", reads: false },
			new AbortController().signal,
			undefined,
			context,
		);
		assert.equal(captured.at(-1), "plain");

		const invalid = await foreground.execute(
			"bad",
			{ agent: "worker", task: "fix it", reads: ["ok", 3] as never },
			new AbortController().signal,
			undefined,
			context,
		);
		assert.equal(invalid.isError, true);
		assert.match(invalid.content[0]?.type === "text" ? invalid.content[0].text : "", /reads.*array.*strings.*false/i);
	} finally {
		rmSync(parentCwd, { recursive: true, force: true });
	}
});
describe("programmatic subagent tool boundary", () => {
	test("accepts supported output limits and rejects unknown fields", () => {
		assert.equal(
			Value.Check(SubagentParams, {
				agent: "worker",
				task: "fix it",
				maxOutput: { bytes: 1024, lines: 100 },
			}),
			true,
		);
		assert.equal(
			Value.Check(SubagentParams, {
				agent: "worker",
				task: "fix it",
				unsupported: true,
			}),
			false,
		);
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
			const result = await executor.execute(
				"single",
				{ agent: "worker", task: "fix it" },
				new AbortController().signal,
				undefined,
				makeContext(cwd, () => {
					customCalls += 1;
					throw new Error("unexpected UI prompt");
				}),
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
			const executor = makeExecutor(
				cwd,
				[makeAgent("worker")],
				{
					isAsyncAvailable: () => true,
					executeAsyncSingle: (_id, params) => {
						assert.ok(typeof params.task === "string");
						backgroundCalls.push({ agent: params.agent, task: params.task });
						return {
							content: [{ type: "text", text: "background started" }],
							details: { mode: "single", results: [] },
						};
					},
					runSync: async (_cwd, _agents, agent, task) => {
						foregroundCalls += 1;
						return makeResult(agent, task);
					},
				},
				true,
			);
			const result = await executor.execute(
				"async-default",
				{ agent: "worker", task: "fix it" },
				new AbortController().signal,
				undefined,
				makeContext(cwd, () => {
					customCalls += 1;
					throw new Error("unexpected UI prompt");
				}),
			);

			assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "background started");
			assert.deepEqual(backgroundCalls, [{ agent: "worker", task: "fix it" }]);
			assert.equal(foregroundCalls, 0);
			assert.equal(customCalls, 0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("async parallel execution rejects more than 50 expanded tasks before dispatch", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-tool-async-limit-"));
		try {
			const executor = makeExecutor(cwd, [makeAgent("worker")], { isAsyncAvailable: () => true });
			const result = await executor.execute(
				"async-parallel-limit",
				{ tasks: [{ agent: "worker", task: "repeat", count: 51 }], async: true },
				new AbortController().signal,
				undefined,
				makeContext(cwd, () => {
					throw new Error("unexpected UI prompt");
				}),
			);

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "Max 50 tasks");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("typed restricted child policy blocks management mutation without environment state", async () => {
		let registered: ToolDefinition | undefined;
		const pi = {
			registerTool: (tool: ToolDefinition) => {
				registered = tool;
			},
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "typed-fanout-child",
		} as unknown as ExtensionAPI;
		registerFanoutChildSubagentExtension(pi, {
			managementActions: "restricted",
			fanoutAuthorized: true,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(registered);
		for (const action of ["create", "update", "delete"] as const) {
			const result = (await registered.execute(
				`typed-restricted-${action}`,
				{ action },
				new AbortController().signal,
				undefined,
				makeContext(process.cwd(), () => {
					throw new Error("unexpected UI prompt");
				}),
			)) as SubagentToolResult;
			assert.equal(result.isError, true);
			assert.match(
				result.content[0]?.type === "text" ? result.content[0].text : "",
				new RegExp(`Action '${action}' is not available from child-safe subagent fanout mode`),
			);
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
			const result = await executor.execute(
				"chain",
				{
					chain: [
						{ agent: "scout", task: "inspect the failure" },
						{ agent: "worker", task: "implement from {previous}" },
					],
				},
				new AbortController().signal,
				undefined,
				makeContext(cwd, () => {
					customCalls += 1;
					throw new Error("unexpected UI prompt");
				}),
			);

			assert.equal(result.isError, undefined);
			assert.equal(customCalls, 0);
			assert.deepEqual(
				runCalls.map((call) => call.agent),
				["scout", "worker"],
			);
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
			const result = await executor.execute(
				"parallel",
				{
					tasks: [
						{ agent: "alpha", task: "inspect alpha" },
						{ agent: "beta", task: "inspect beta" },
					],
				},
				new AbortController().signal,
				undefined,
				makeContext(cwd, () => {
					customCalls += 1;
					throw new Error("unexpected UI prompt");
				}),
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
			const runCalls: Array<{ agent: string; task: string }> = [];
			const executor = makeExecutor(cwd, [makeAgent("alpha"), makeAgent("beta")], {
				isAsyncAvailable: () => true,
				executeAsyncSingle: (_id, params) => {
					asyncSingle.push({ agent: params.agent, task: params.task ?? "" });
					return { content: [{ type: "text", text: "single started" }], details: { mode: "single", results: [] } };
				},
				runSync: async (_cwd, _agents, agent, task) => {
					runCalls.push({ agent, task });
					return makeResult(agent, task);
				},
			});
			const ctx = makeContext(cwd, () => {
				customCalls += 1;
				throw new Error("unexpected UI prompt");
			});
			const signal = new AbortController().signal;

			await executor.execute("async-single", { agent: "alpha", task: "one", async: true }, signal, undefined, ctx);
			const parallel = await executor.execute(
				"async-parallel",
				{
					tasks: [
						{ agent: "alpha", task: "one" },
						{ agent: "beta", task: "two" },
					],
					async: true,
				},
				signal,
				undefined,
				ctx,
			);
			const chain = await executor.execute(
				"async-chain",
				{
					chain: [
						{ agent: "alpha", task: "first" },
						{ agent: "beta", task: "continue from {previous}" },
					],
					async: true,
				},
				signal,
				undefined,
				ctx,
			);
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.equal(customCalls, 0);
			assert.deepEqual(asyncSingle, [{ agent: "alpha", task: "one" }]);
			assert.equal(parallel.details.results[0]?.status, "continued");
			assert.equal(chain.details.results[0]?.status, "continued");
			assert.deepEqual(
				runCalls.map((call) => call.agent),
				["alpha", "beta", "alpha", "beta"],
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("parent registration exposes the non-interactive tool and preserves slash commands", async () => {
		let registered: ToolDefinition | undefined;
		const commands: string[] = [];
		const handlers = new Map<string, Array<() => void>>();
		const pi = {
			registerTool: (tool: ToolDefinition) => {
				registered = tool;
			},
			registerCommand: (name: string) => {
				commands.push(name);
			},
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
			makeContext(process.cwd(), () => {
				customCalls += 1;
				throw new Error("unexpected UI prompt");
			}),
		);
		assert.equal(customCalls, 0);
		assert.match(
			result.content[0]?.type === "text" ? result.content[0].text : "",
			/First step in chain must have a task/,
		);

		assert.deepEqual(commands.filter((name) => ["run", "chain", "parallel", "run-chain"].includes(name)).sort(), [
			"chain",
			"parallel",
			"run",
			"run-chain",
		]);

		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
		for (const args of [
			{ agent: "worker", async: true },
			{ tasks: [{ agent: "worker", task: "one" }], async: true },
			{ chain: [{ agent: "worker", task: "one" }], async: true },
		]) {
			const component = registered.renderCall?.(args as never, theme, {} as never);
			assert.match(component?.render(120).join("\n") ?? "", /\[async\]/);
		}
		for (const shutdown of handlers.get("session_shutdown") ?? []) shutdown();
	});

	test("slash bridge dispatch remains separate and forwards its parameters unchanged", async () => {
		const events = new FakeEvents();
		let received: Record<string, unknown> | undefined;
		const response = new Promise<void>((resolve) => {
			const unsubscribe = events.on(SLASH_SUBAGENT_RESPONSE_EVENT, () => {
				unsubscribe();
				resolve();
			});
		});
		const bridge = registerSlashSubagentBridge({
			events,
			getContext: () =>
				makeContext("/tmp", () => {
					throw new Error("not used");
				}),
			execute: async (_id, params) => {
				received = params as unknown as Record<string, unknown>;
				return { content: [{ type: "text", text: "done" }], details: { mode: "chain", results: [] } };
			},
		});

		events.emit(SLASH_SUBAGENT_REQUEST_EVENT, {
			requestId: "slash-chain",
			params: { chain: [{ agent: "worker", task: "one" }], async: true },
		});
		await response;

		assert.deepEqual(received, { chain: [{ agent: "worker", task: "one" }], async: true });
		bridge.dispose();
	});
});
