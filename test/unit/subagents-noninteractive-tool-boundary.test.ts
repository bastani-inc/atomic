import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@bastani/atomic";
import { Value } from "typebox/value";
import { describe, test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
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

function makeExecutor(cwd: string, agents: AgentConfig[], runtime: Partial<SubagentExecutorRuntimeDeps>) {
	const state: ExecutorDeps["state"] = {
		baseCwd: "",
		currentSessionId: null,
		subagentInProgress: false,
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
	return createSubagentExecutor({
		pi: {
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "parent",
		} as unknown as ExecutorDeps["pi"],
		state,
		config: { parallel: { concurrency: 4, maxTasks: 50 } },
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

test("root single reads are schema-valid and cwd-correct", async () => {
	const parentCwd = mkdtempSync(join(tmpdir(), "atomic-subagent-root-reads-"));
	try {
		const childCwd = join(parentCwd, "child");
		const absoluteRead = join(parentCwd, "absolute.md");
		const reads = ["docs/a.md", "../shared.md", absoluteRead];
		assert.equal(Value.Check(SubagentParams, { agent: "worker", task: "fix it", cwd: "child", reads }), true);
		assert.equal(Value.Check(SubagentParams, { agent: "worker", task: "fix it", reads: true }), false);
		const captured: string[] = [];
		const executor = makeExecutor(parentCwd, [makeAgent("worker")], {
			runSync: async (_cwd, _agents, agent, task) => {
				captured.push(task);
				return makeResult(agent, task);
			},
		});
		const context = makeContext(parentCwd, () => {
			throw new Error("unexpected prompt");
		});
		await executor.execute(
			"fg",
			{ agent: "worker", task: "fix it", cwd: "child", reads },
			new AbortController().signal,
			undefined,
			context,
		);
		const expected = `[Read from: ${join(childCwd, "docs/a.md")}, ${join(parentCwd, "shared.md")}, ${absoluteRead}]\n\nfix it`;
		assert.deepEqual(captured, [expected]);
		await executor.execute(
			"disabled",
			{ agent: "worker", task: "plain", reads: false },
			new AbortController().signal,
			undefined,
			context,
		);
		assert.equal(captured.at(-1), "plain");

		const invalid = await executor.execute(
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

	test("typed restricted child policy blocks management mutation without environment state", async () => {
		let registered: ToolDefinition | undefined;
		const pi = {
			registerTool: (tool: ToolDefinition) => {
				registered = tool;
			},
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "typed-fanout-child",
			registerCommand: () => {},
			registerMessageRenderer: () => {},
			sendMessage: () => {},
			on: () => {},
		} as unknown as ExtensionAPI;
		// The production door: the full extension resolves a child-scoped executor
		// from `ctx.subagentPolicy`, so the policy must be carried on the context.
		registerSubagentExtension(pi);
		const restrictedChildPolicy = {
			managementActions: "restricted" as const,
			fanoutAuthorized: true,
			inheritProjectContext: false,
			inheritSkills: false,
		};

		assert.ok(registered);
		for (const action of ["create", "update", "delete"] as const) {
			const ctx = makeContext(process.cwd(), () => {
				throw new Error("unexpected UI prompt");
			}) as ExtensionContext & { subagentPolicy?: typeof restrictedChildPolicy };
			ctx.subagentPolicy = restrictedChildPolicy;
			const result = (await registered.execute(
				`typed-restricted-${action}`,
				{ action },
				new AbortController().signal,
				undefined,
				ctx,
			)) as SubagentToolResult;
			assert.equal(result.isError, true);
			assert.match(
				result.content[0]?.type === "text" ? result.content[0].text : "",
				new RegExp(`Action '${action}' is not available from child-safe subagent fanout mode`),
			);
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

	test("parent registration exposes the non-interactive tool and does not register slash commands", async () => {
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
			"parent-parallel",
			{ tasks: [{ agent: "debugger", task: "inspect" }] },
			new AbortController().signal,
			undefined,
			makeContext(process.cwd(), () => {
				customCalls += 1;
				throw new Error("unexpected UI prompt");
			}),
		);
		assert.equal(customCalls, 0);
		assert.equal((result as { details?: { mode?: string } }).details?.mode, "parallel");

		assert.deepEqual(
			commands.filter((name) => ["run", "parallel"].includes(name)),
			[],
		);

		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
		for (const args of [{ agent: "worker" }, { tasks: [{ agent: "worker", task: "one" }] }]) {
			const component = registered.renderCall?.(args as never, theme, {} as never);
			assert.doesNotMatch(component?.render(120).join("\n") ?? "", /\[async\]/);
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
				return { content: [{ type: "text", text: "done" }], details: { mode: "parallel", results: [] } };
			},
		});

		events.emit(SLASH_SUBAGENT_REQUEST_EVENT, {
			requestId: "slash-parallel",
			params: { tasks: [{ agent: "worker", task: "one" }] },
		});
		await response;

		assert.deepEqual(received, { tasks: [{ agent: "worker", task: "one" }] });
		bridge.dispose();
	});
});
