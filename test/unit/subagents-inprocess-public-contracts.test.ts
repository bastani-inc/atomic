import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, beforeEach, test } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import type { SubagentState } from "../../packages/subagents/src/shared/types.js";
import { sleep, spawnSyncCollect } from "../helpers/runtime.js";

type EventHandler = (data: unknown) => void;

class TestEvents {
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

const tempRoots: string[] = [];
const states: SubagentState[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "atomic-subagent-public-contract-"));
	tempRoots.push(root);
	return root;
}

function agent(): AgentConfig {
	return {
		name: "qa-echo",
		description: "test echo agent",
		systemPrompt: "Return the fixture output.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: "/tmp/qa-echo.md",
	};
}

function state(cwd: string): SubagentState {
	const value: SubagentState = {
		baseCwd: cwd,
		currentSessionId: "parent-session",
		subagentInProgress: false,
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
	states.push(value);
	return value;
}

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		ui: {},
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => join(cwd, "parent-session.jsonl"),
			getSessionId: () => "parent-session",
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

function executor(
	cwd: string,
	events: TestEvents,
	runtime: Partial<SubagentExecutorRuntimeDeps> = {},
): { execute: ReturnType<typeof createSubagentExecutor>; state: SubagentState } {
	const currentState = state(cwd);
	const execute = createSubagentExecutor({
		pi: {
			events,
			getSessionName: () => "parent",
		} as unknown as ExecutorDeps["pi"],
		state: currentState,
		config: { parallel: { concurrency: 4, maxTasks: 50 } },
		tempArtifactsDir: join(cwd, "artifacts"),
		getSubagentSessionRoot: () => join(cwd, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [agent()] }),
		runtime,
	});
	return { execute, state: currentState };
}

function text(result: Awaited<ReturnType<ReturnType<typeof createSubagentExecutor>["execute"]>>): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

beforeEach(() => {
	clearSubagentControls();
});

afterEach(() => {
	clearSubagentControls();
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("public parallel dispatch retries capacity refusals until all six tasks complete", async () => {
	const cwd = makeRoot();
	const { execute } = executor(cwd, new TestEvents());
	const result = await execute.execute(
		"parallel-six",
		{
			tasks: Array.from({ length: 6 }, (_, index) => ({ agent: "qa-echo", task: `echo ${index + 1}` })),
			concurrency: 6,
			artifacts: false,
		},
		new AbortController().signal,
		undefined,
		context(cwd),
	);

	assert.equal(result.details.results.length, 6);
	assert.deepEqual(
		result.details.results.map((child) => child.status),
		["ok", "ok", "ok", "ok", "ok", "ok"],
	);
	assert.ok(result.details.results.every((child) => !child.cause?.includes("capacity")));
	assert.match(text(result), /^6\/6 succeeded/);
});

test("public parallel count expansion preserves task multiplicity and concurrency", async () => {
	const cwd = makeRoot();
	let active = 0;
	let maximumActive = 0;
	const seenTasks: string[] = [];
	const { execute } = executor(cwd, new TestEvents(), {
		runSync: async (_cwd, _agents, agentName, task) => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			seenTasks.push(task);
			await sleep(15);
			active -= 1;
			return {
				agent: agentName,
				task,
				status: "ok" as const,
				messages: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				finalOutput: task,
			};
		},
	});
	const result = await execute.execute(
		"parallel-count",
		{
			tasks: [
				{ agent: "qa-echo", task: "repeat", count: 3 },
				{ agent: "qa-echo", task: "once" },
			],
			concurrency: 2,
			artifacts: false,
		},
		new AbortController().signal,
		undefined,
		context(cwd),
	);

	assert.equal(result.details.results.length, 4);
	assert.deepEqual(seenTasks.sort(), ["once", "repeat", "repeat", "repeat"]);
	assert.equal(maximumActive, 2);
	assert.ok(result.details.results.every((child) => child.status === "ok"));
});

test("public parallel worktree mode gives each task an isolated checkout", async () => {
	const cwd = makeRoot();
	const runGit = (args: string[]): string => {
		const result = spawnSyncCollect(["git", ...args], { cwd, env: createGitEnvironment() });
		assert.equal(result.exitCode, 0, result.stderr.toString());
		return result.stdout.toString("utf8");
	};
	runGit(["init", "--quiet"]);
	runGit(["config", "user.name", "Atomic Fixture"]);
	runGit(["config", "user.email", "fixture@example.invalid"]);
	runGit(["config", "commit.gpgSign", "false"]);
	writeFileSync(join(cwd, "seed.txt"), "seed\n");
	runGit(["add", "seed.txt"]);
	runGit(["commit", "--quiet", "-m", "initial"]);

	const childCwds: string[] = [];
	const { execute } = executor(cwd, new TestEvents(), {
		runSync: async (_parentCwd, _agents, agentName, task, options) => {
			const childCwd = options?.cwd ?? "";
			childCwds.push(childCwd);
			assert.notEqual(childCwd, cwd);
			assert.equal(existsSync(join(childCwd, ".git")), true);
			writeFileSync(join(childCwd, `${task}.txt`), `${task}\n`);
			return {
				agent: agentName,
				task,
				status: "ok" as const,
				messages: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				finalOutput: task,
			};
		},
	});
	const result = await execute.execute(
		"parallel-worktree",
		{
			tasks: [
				{ agent: "qa-echo", task: "alpha", progress: false },
				{ agent: "qa-echo", task: "beta", progress: false },
			],
			worktree: true,
			artifacts: false,
		},
		new AbortController().signal,
		undefined,
		context(cwd),
	);

	assert.equal(result.details.results.length, 2, text(result));
	assert.equal(new Set(childCwds).size, 2);
	assert.match(text(result), /=== Worktree Changes ===/);
	const remainingWorktrees = runGit(["worktree", "list", "--porcelain"])
		.split("\n")
		.filter((line) => line.startsWith("worktree "));
	assert.equal(remainingWorktrees.length, 1);
});
test("public interrupt accepts both bare run ids and canonical child paths", async () => {
	for (const form of ["bare", "canonical"] as const) {
		const cwd = makeRoot();
		const gate = Promise.withResolvers<void>();
		const promptLogPath = join(cwd, `prompt-${form}.log`);
		const { execute } = executor(cwd, new TestEvents(), {
			runSync: async (parentCwd, agents, agentName, task, options) =>
				runSync(parentCwd, agents, agentName, task, {
					...options,
					testSession: {
						output: "interrupted output",
						promptGate: gate.promise,
						promptLogPath,
						abortResolvesPrompt: true,
					},
				}),
		});
		const ctx = context(cwd);
		const running = execute.execute(
			`foreground-${form}`,
			{ agent: "qa-echo", task: `wait for ${form} management`, artifacts: false },
			new AbortController().signal,
			undefined,
			ctx,
		);

		for (let attempt = 0; attempt < 200 && !existsSync(promptLogPath); attempt++) await sleep(5);
		assert.equal(existsSync(promptLogPath), true, "foreground child prompt should start before management actions");

		const status = await execute.execute(
			`status-${form}`,
			{ action: "status" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		const statusText = text(status);
		const liveStatus = /^Parent: (\S+)\n(\S+\/\S+) — running \(loaded\)$/m.exec(statusText);
		const runId = liveStatus?.[1];
		const childPath = liveStatus?.[2];
		assert.ok(runId, statusText);
		assert.ok(childPath, statusText);
		assert.match(childPath, new RegExp(`^${runId}/qa-echo_1$`));
		const id = form === "bare" ? runId : childPath;

		const interrupted = await execute.execute(
			`interrupt-${form}`,
			{ action: "interrupt", id },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(interrupted.isError, undefined, text(interrupted));
		assert.match(text(interrupted), /Interrupt requested/);
		const terminal = await running;
		assert.match(text(terminal), /Run ended after interrupt/);
		gate.resolve();
	}
});
