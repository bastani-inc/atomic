import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { validateToolArguments } from "@bastani/pi-ai";
import { afterEach, beforeEach, test } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { OperationId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { prepareSubagentArguments, SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import {
	clearSubagentControls,
	listSubagentControls,
} from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import type { SingleResult, SubagentState } from "../../packages/subagents/src/shared/types.js";
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
		config: { parallel: { concurrency: 4, maxTasks: 50, runningCapacity: 4 } },
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

test("subagent schema accepts run control and rejects the removed kill and interrupt actions", () => {
	const tool = { name: "subagent", description: "test subagent", parameters: SubagentParams };
	const call = (action: string) => ({
		type: "toolCall" as const,
		id: "schema",
		name: "subagent",
		arguments: { action, id: "raw/child" },
	});
	for (const action of ["pause", "resume", "quit"])
		assert.deepEqual(validateToolArguments(tool, call(action)), { action, id: "raw/child" });
	for (const action of ["kill", "interrupt"]) {
		assert.throws(() => validateToolArguments(tool, call(action)));
		assert.throws(
			() => prepareSubagentArguments({ action, id: "raw/child" }),
			new RegExp(`"${action}" was removed\\. Use \\{ action: "quit"`),
		);
	}
	assert.deepEqual(prepareSubagentArguments({ action: "quit", id: "c" }), { action: "quit", id: "c" });
});

test("kill and interrupt are rejected with an error that names quit as the replacement", async () => {
	const cwd = makeRoot();
	const { execute } = executor(cwd, new TestEvents());
	for (const action of ["kill", "interrupt"]) {
		const result = await execute.execute(
			"command-contract",
			// @ts-expect-error Exercise removed public action input at runtime.
			{ action, id: "child" },
			new AbortController().signal,
			undefined,
			context(cwd),
		);
		assert.equal(result.isError, true);
		assert.match(text(result), new RegExp(`"${action}" was removed\\. Use \\{ action: "quit", id \\}`));
		assert.doesNotMatch(text(result), /Unknown action/);
	}
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
test("management status and wait resolve the launch task ID and report an owner cancellation as non-resumable", async () => {
	const cwd = makeRoot();
	const { execute } = executor(cwd, new TestEvents());
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: "management-owner" }, authorizeLaunch() {} });
	const ctx = { ...context(cwd), getAgentTaskHost: () => host };
	try {
		const started = await host.startAgentTask(
			{ kind: "agent", agent: "qa-echo", task: "Pending review" },
			"management-fixture" as OperationId,
			(hooks) => {
				const result = new Promise<TaskResult>((resolve) =>
					hooks.signal.addEventListener("abort", () => resolve({ kind: "cancelled", cause: "user" }), {
						once: true,
					}),
				);
				return { result, cleanup: result.then(() => ({ kind: "reaped" as const })) };
			},
		);
		assert.ok(started.ok);
		await host.observeAgentLaunch(started.value.taskId);
		const call = (action: "status" | "wait") =>
			execute.execute(
				`management-${action}`,
				{ action, id: started.value.taskId, budgetMs: 1 },
				new AbortController().signal,
				undefined,
				ctx,
			);
		const status = await call("status");
		assert.equal(status.details?.taskRecords?.[0].execution.kind, "running");
		const waited = await call("wait");
		assert.equal(waited.details?.taskResponse?.kind, "admitted");
		await host.cancelTask(started.value.taskId, "user");
		await host.waitForTask(started.value.taskId);
		const stopped = await call("status");
		assert.equal(stopped.details?.taskRecords?.[0].execution.kind, "settled");
		assert.equal(stopped.details?.taskRecords?.length, 1);
		assert.match(text(stopped), /Killed.*cannot be resumed/);
		assert.match(text(await call("wait")), /Killed.*cannot be resumed/);
	} finally {
		await host.close("session-close");
	}
});

test("owner task cancellation reaches a real child and wait preserves raw cancellation under a killed receipt", async () => {
	{
		const field = "owner";
		const cwd = makeRoot();
		const gate = Promise.withResolvers<void>();
		const promptLogPath = join(cwd, "owner-prompt.log");
		const { execute } = executor(cwd, new TestEvents(), {
			runSync: (parentCwd, agents, agentName, task, options) =>
				runSync(parentCwd, agents, agentName, task, {
					...options,
					testSession: { promptGate: gate.promise, promptLogPath, abortResolvesPrompt: true },
				}),
		});
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: `owner-kill-${field}` },
			authorizeLaunch() {},
		});
		const ctx = { ...context(cwd), getAgentTaskHost: () => host };
		try {
			const launched = await execute.execute(
				"launch-owner",
				{ agent: "qa-echo", task: "hold", artifacts: false, wait: { kind: "background" } },
				new AbortController().signal,
				undefined,
				ctx,
			);
			const response = launched.details.taskResponse;
			assert.equal(response?.kind, "admitted");
			assert.ok(response?.kind === "admitted");
			const taskId = response.observation.taskId;
			for (let attempt = 0; attempt < 200 && !existsSync(promptLogPath); attempt++) await sleep(5);
			assert.ok(existsSync(promptLogPath));
			const killed = await host.cancelTask(taskId, "user");
			assert.ok(killed.ok);
			const stopped = await host.waitForTask(taskId);
			assert.ok(stopped.ok && stopped.value.kind === "settled");
			assert.equal(stopped.value.result.kind, "cancelled");
			const waited = await execute.execute(
				"wait-owner",
				{ action: "wait", id: taskId },
				new AbortController().signal,
				undefined,
				ctx,
			);
			assert.match(text(waited), /Killed.*cannot be resumed/);
			const status = await execute.execute(
				"status-child",
				{ action: "status" },
				new AbortController().signal,
				undefined,
				ctx,
			);
			assert.match(text(status), /killed/);
		} finally {
			gate.resolve();
			await host.close("session-close");
		}
	}
});

test("owner foreground parallel cancellation preserves sibling execution and raw host records under a killed receipt", async () => {
	const cwd = makeRoot();
	const gate = Promise.withResolvers<void>();
	const { execute } = executor(cwd, new TestEvents(), {
		runSync: (parentCwd, agents, agentName, task, options) =>
			runSync(parentCwd, agents, agentName, task, {
				...options,
				testSession: {
					promptGate: gate.promise,
					promptLogPath: join(cwd, `${task}.log`),
					abortResolvesPrompt: true,
				},
			}),
	});
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: "parallel-kill" }, authorizeLaunch() {} });
	const ctx = { ...context(cwd), getAgentTaskHost: () => host };
	const call = (params: Parameters<typeof execute.execute>[1]) =>
		execute.execute("parallel-kill", params, new AbortController().signal, undefined, ctx);
	const launch = call({
		tasks: ["first", "second"].map((task) => ({ agent: "qa-echo", task })),
		wait: { kind: "foreground" },
		artifacts: false,
	});
	try {
		await waitUntil(() => ["first", "second"].every((task) => existsSync(join(cwd, `${task}.log`))));
		const watched = host.watchOwnerTasks();
		assert.ok(watched.ok);
		const ids = watched.value.snapshot.tasks.map((task) => task.ref.taskId);
		watched.value.dispose();
		assert.equal(ids.length, 2);
		const killed = await host.cancelTask(ids[0]!, "user");
		assert.ok(killed.ok);
		const stopped = await host.waitForTask(ids[0]!);
		assert.ok(stopped.ok && stopped.value.kind === "settled");
		assert.equal(stopped.value.result.kind, "cancelled");
		assert.ok(stopped.value.result.kind === "cancelled");
		assert.equal(stopped.value.result.cause, "user");
		const sibling = await host.waitForTask(ids[1]!, 0);
		assert.ok(sibling.ok && sibling.value.kind === "yielded");
		gate.resolve();
		const terminal = await launch;
		assert.match(text(terminal), /1 killed.*cannot be resumed/);
		const [, rawResponse] = text(terminal).split("\n");
		assert.deepEqual(JSON.parse(rawResponse!), terminal.details.taskResponse);
		assert.match(text(terminal), /Output of task-[\w-]+ \(completed, \d+ bytes\):\nFull output: /);
		const response = terminal.details.taskResponse;
		assert.ok(response?.kind === "parallel");
		assert.deepEqual(
			response.slots.map(({ outcome }) => {
				assert.ok(outcome.kind === "admitted" && outcome.observation.kind === "settled");
				return outcome.observation.result.kind;
			}),
			["cancelled", "completed"],
		);
		assert.equal(terminal.details.taskRecords?.length, 2);
	} finally {
		gate.resolve();
		await host.close("session-close");
		await launch;
	}
});

{
	const field = "owner";
	test(`${field} cancellation during native capacity wait is killed, cold and terminal`, async () => {
		const cwd = makeRoot();
		const gate = Promise.withResolvers<void>();
		const terminal: SingleResult[] = [];
		const { execute } = executor(cwd, new TestEvents(), {
			runSync: async (parentCwd, agents, agentName, task, options) => {
				const result = await runSync(parentCwd, agents, agentName, task, {
					...options,
					testSession: { promptGate: gate.promise, abortResolvesPrompt: true },
				});
				terminal.push(result);
				return result;
			},
		});
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: `capacity-${field}` },
			authorizeLaunch() {},
		});
		const ctx = { ...context(cwd), getAgentTaskHost: () => host };
		const call = (params: Parameters<typeof execute.execute>[1]) =>
			execute.execute("capacity-kill", params, new AbortController().signal, undefined, ctx);
		try {
			const launched = await call({
				tasks: Array.from({ length: 5 }, (_, index) => ({ agent: "qa-echo", task: `hold ${index}` })),
				concurrency: 5,
				wait: { kind: "background" },
				artifacts: false,
			});
			const response = launched.details.taskResponse;
			assert.ok(response?.kind === "parallel");
			const ids = response.slots.map(({ outcome }) => {
				assert.ok(outcome.kind === "admitted");
				return outcome.observation.taskId;
			});
			await waitUntil(() => listSubagentControls().some((control) => control.listChildren().length === 5));
			const control = listSubagentControls().find((control) => control.listChildren().length === 5)!;
			const children = control.listChildren();
			assert.deepEqual(
				children.map(({ status, loaded }) => ({ status, loaded })),
				[
					...Array.from({ length: 4 }, () => ({ status: "running", loaded: true })),
					{ status: "pending", loaded: false },
				],
			);
			const path = children[4]!.path;
			const watched: string[] = [];
			control.subscribe(path, (status) => watched.push(status));
			const killed = await host.cancelTask(ids[4]!, "user");
			assert.ok(killed.ok);
			const stopped = await host.waitForTask(ids[4]!);
			assert.ok(stopped.ok && stopped.value.kind === "settled");
			assert.equal(stopped.value.result.kind, "cancelled");
			assert.ok(stopped.value.result.kind === "cancelled");
			assert.equal(stopped.value.result.cause, "user");
			assert.equal(terminal.length, 1);
			assert.equal(terminal[0]!.status, "killed");
			assert.equal(terminal[0]!.cause, undefined);
			assert.equal(terminal[0]!.progress?.status, "killed");
			assert.match(terminal[0]!.envelope!, /Killed.*cannot be resumed/);
			assert.doesNotMatch(terminal[0]!.envelope!, /cancelled by parent/);
			assert.match(text(await call({ action: "status" })), /qa-echo_5 — killed \(cold\)/);
			assert.equal(control.native.listChildren().find((child) => child.path === path)?.status, "interrupted");
			await waitUntil(() => watched.includes("killed"));
			assert.ok(
				control
					.listChildren()
					.slice(0, 4)
					.every((child) => child.status === "running"),
			);
			gate.resolve();
			await Promise.all(ids.map((id) => host.waitForTask(id)));
			assert.deepEqual(
				terminal.map((result) => result.status),
				["killed", "ok", "ok", "ok", "ok"],
			);
			assert.equal(control.findChild(path)?.status, "killed");
		} finally {
			gate.resolve();
			await host.close("session-close");
		}
	});
}

for (const cause of ["parent-default", "parent-user", "owner-close"] as const) {
	test(`${cause} at capacity preserves abort`, async () => {
		const cwd = makeRoot();
		const gate = Promise.withResolvers<void>();
		const abort = new AbortController();
		const terminal: SingleResult[] = [];
		const { execute } = executor(cwd, new TestEvents(), {
			runSync: async (parentCwd, agents, agentName, task, options) => {
				const result = await runSync(parentCwd, agents, agentName, task, {
					...options,
					testSession: { promptGate: gate.promise, abortResolvesPrompt: true },
				});
				terminal.push(result);
				return result;
			},
		});
		const host = new AgentTaskHost({ scope: { kind: "session", sessionId: cwd }, authorizeLaunch() {} });
		const ctx = cause === "owner-close" ? { ...context(cwd), getAgentTaskHost: () => host } : context(cwd);
		const launch = execute.execute(
			cause,
			{
				tasks: Array.from({ length: 5 }, (_, index) => ({ agent: "qa-echo", task: `hold ${index}` })),
				concurrency: 5,
				artifacts: false,
			},
			abort.signal,
			undefined,
			ctx,
		);
		try {
			await waitUntil(() => listSubagentControls().some((control) => control.listChildren().length === 5));
			const control = listSubagentControls().find((control) => control.listChildren().length === 5)!;
			const waiting = control.listChildren()[4]!;
			assert.equal(waiting.status, "pending");
			assert.equal(waiting.loaded, false);
			const closing = cause === "owner-close" ? host.close("session-close") : undefined;
			if (cause === "parent-user") abort.abort("user");
			else if (cause === "parent-default") abort.abort();
			await closing;
			await launch;
			await waitUntil(() => terminal.length === 5);
			for (const result of terminal) {
				assert.equal(result.status, "interrupted");
				assert.equal(result.cause, "abort");
				assert.match(result.envelope!, /Run cancelled by parent/);
				assert.doesNotMatch(result.envelope!, /killed/i);
			}
			assert.equal(control.findChild(waiting.path)?.status, "interrupted");
			assert.equal(control.findChild(waiting.path)?.loaded, false);
		} finally {
			gate.resolve();
			await host.close("session-close");
			await launch;
		}
	});
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 2_400; attempt++) {
		if (predicate()) return;
		await sleep(5);
	}
	assert.ok(predicate(), "expected child execution state before management action");
}
