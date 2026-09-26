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
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import {
	clearSubagentControls,
	listSubagentControls,
	registerSubagentControl,
} from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { SubagentControlRuntime } from "../../packages/subagents/src/runs/inprocess/runner.js";
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

test("subagent schema accepts kill and rejects interrupt through provider validation", () => {
	const tool = { name: "subagent", description: "test subagent", parameters: SubagentParams };
	const call = (action: string) => ({
		type: "toolCall" as const,
		id: "schema",
		name: "subagent",
		arguments: { action, id: "raw/child" },
	});
	assert.deepEqual(validateToolArguments(tool, call("kill")), { action: "kill", id: "raw/child" });
	assert.throws(() => validateToolArguments(tool, call("interrupt")));
});

test("public kill replaces interrupt without retaining an alias", async () => {
	const cwd = makeRoot();
	const { execute } = executor(cwd, new TestEvents());
	for (const action of ["kill", "interrupt"]) {
		const result = await execute.execute(
			"command-contract",
			// @ts-expect-error Exercise invalid public action input at runtime.
			{ action },
			new AbortController().signal,
			undefined,
			context(cwd),
		);
		assert.equal(result.isError, true);
		if (action === "interrupt") assert.match(text(result), /Unknown action: interrupt/);
		else assert.doesNotMatch(text(result), /Unknown action/);
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
test("public kill accepts both bare run ids and canonical child paths", async () => {
	for (const form of ["bare", "canonical"] as const) {
		const cwd = makeRoot();
		const gate = Promise.withResolvers<void>();
		const promptLogPath = join(cwd, `prompt-${form}.log`);
		const { execute } = executor(cwd, new TestEvents(), {
			runSync: async (parentCwd, agents, agentName, task, options) =>
				runSync(parentCwd, agents, agentName, task, {
					...options,
					testSession: {
						output: "partial output",
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

		const killed = await execute.execute(
			`kill-${form}`,
			{ action: "kill", ...(form === "bare" ? { runId: id } : { id }) },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(killed.isError, undefined, text(killed));
		assert.match(text(killed), /Kill requested/);
		const terminal = await running;
		assert.equal(terminal.details.results[0].status, "killed");
		assert.match(text(terminal), /Killed/);
		assert.match(text(terminal), /cannot be resumed/);
		const stopped = await execute.execute(
			"stopped-status",
			{ action: "status", id: childPath },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.match(text(stopped), /Status: killed/);
		const repeated = await execute.execute(
			"repeated-kill",
			{ action: "kill", id: childPath },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(repeated.isError, true);
		assert.match(text(repeated), /No running in-process child/);
		gate.resolve();
	}
});

test("management status, wait and kill resolve the launch task ID without starting another child", async () => {
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
		const call = (action: "status" | "wait" | "kill") =>
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
		await call("kill");
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

test("owner task kill reaches a real child and wait preserves raw cancellation under a killed receipt", async () => {
	for (const field of ["id", "runId"] as const) {
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
			const killed = await execute.execute(
				"kill-owner",
				{ action: "kill", [field]: taskId },
				new AbortController().signal,
				undefined,
				ctx,
			);
			assert.notEqual(killed.isError, true, text(killed));
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

test("owner foreground parallel kill preserves sibling execution and raw host records under a killed receipt", async () => {
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
		// Owner lookup retains id precedence when both target fields are supplied.
		const killed = await call({ action: "kill", id: ids[0], runId: ids[1] });
		assert.notEqual(killed.isError, true, text(killed));
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

for (const field of ["id", "runId"] as const) {
	test(`owner public kill via ${field} during native capacity wait is killed, cold and terminal`, async () => {
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
			const killed = await call({ action: "kill", [field]: ids[4] });
			assert.notEqual(killed.isError, true, text(killed));
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
			assert.equal((await call({ action: "kill", id: path })).isError, true);
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

test("late public kill by runId preserves an already-published native interrupt before JS completion", async () => {
	const cwd = makeRoot();
	const gate = Promise.withResolvers<void>();
	const interrupt = new AbortController();
	const control = new SubagentControlRuntime({ path: "native-interrupt-won", depth: 0 }, join(cwd, "sessions"));
	control.registerAgents([agent()]);
	registerSubagentControl(control);
	const admitted = control.admitChildSession({
		taskName: "hold",
		task: "wait for lower-level interruption",
		agent: agent(),
		cwd,
		testSession: { promptGate: gate.promise, abortResolvesPrompt: true },
	});
	assert.ok(admitted.admitted);
	const running = control.startAttempt(
		admitted.admitted,
		{},
		{
			abort: new AbortController().signal,
			interrupt: interrupt.signal,
		},
	);
	const path = running.child.identity.path;
	const { execute } = executor(cwd, new TestEvents());
	const call = (action: "kill" | "status") =>
		execute.execute(
			"native-interrupt-won",
			{ action, runId: path },
			new AbortController().signal,
			undefined,
			context(cwd),
		);
	try {
		interrupt.abort();
		// Yield only microtasks: the native worker can publish interruption while its JS completion stays queued.
		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline && control.native.listChildren()[0]?.status !== "interrupted")
			await Promise.resolve();
		assert.equal(
			control.native.listChildren()[0]?.status,
			"interrupted",
			"native interruption must already have won",
		);
		assert.equal(running.status, "running", "the JS attempt must still be pending when the late kill arrives");
		assert.equal(control.findChild(path)?.status, "interrupted");

		const requested = await call("kill");
		assert.notEqual(requested.isError, true, text(requested));
		const result = await running.promise;
		assert.equal(result.status, "interrupted");
		assert.equal(result.cause, undefined);
		assert.equal(result.envelope, "Interrupted");
		assert.doesNotMatch(result.envelope, /killed|cannot be resumed/i);
		assert.equal(control.native.listChildren()[0]?.status, "interrupted");
		assert.equal(control.findChild(path)?.status, "interrupted");
		const status = await call("status");
		assert.match(text(status), /Status: interrupted/);
		assert.doesNotMatch(text(status), /killed|cannot be resumed/i);
		assert.equal(status.details.statusGroups?.[0]?.children[0]?.status, "interrupted");
	} finally {
		gate.resolve();
		await running.promise;
	}
});

for (const field of ["id", "runId"] as const) {
	for (const abortResolvesPrompt of [true, false]) {
		test.each(["interrupt", "parent-default", "parent-user", "kill"] as const)(
			`late public kill via ${field} after finalization preserves %s (prompt resolves: ${abortResolvesPrompt})`,
			async (first) => {
				const cwd = makeRoot();
				const gate = Promise.withResolvers<void>();
				const lateRequest = Promise.withResolvers<void>();
				const abort = new AbortController();
				const interrupt = new AbortController();
				const expectedStatus = first === "kill" ? "killed" : "interrupted";
				const parentCancelled = first === "parent-default" || first === "parent-user";
				const control = new SubagentControlRuntime(
					{ path: "finalized-interrupt", depth: 0 },
					join(cwd, "sessions"),
				);
				control.registerAgents([agent()]);
				registerSubagentControl(control);
				const { execute } = executor(cwd, new TestEvents());
				const call = (action: "kill" | "status") =>
					execute.execute(
						"finalized-interrupt",
						{ action, [field]: path },
						new AbortController().signal,
						undefined,
						context(cwd),
					);
				const admitted = control.admitChildSession({
					taskName: "hold",
					task: "wait for interruption",
					agent: agent(),
					cwd,
					testSession: {
						promptGate: gate.promise,
						abortResolvesPrompt,
						dispose() {
							// The result is finalized, but its outer promise has not yet retired the attempt.
							queueMicrotask(() => {
								void (async () => {
									assert.equal(running.status, "running");
									assert.equal(control.native.listChildren()[0]?.status, "interrupted");
									assert.equal(control.findChild(path)?.status, expectedStatus);
									const requested = call("kill");
									assert.equal(control.findChild(path)?.status, expectedStatus);
									const receipt = await requested;
									assert.notEqual(receipt.isError, true, text(receipt));
								})().then(lateRequest.resolve, lateRequest.reject);
							});
						},
					},
				});
				assert.ok(admitted.admitted);
				const running = control.startAttempt(
					admitted.admitted,
					{},
					{
						abort: abort.signal,
						interrupt: interrupt.signal,
					},
				);
				const path = running.child.identity.path;
				try {
					const firstRequest = first === "kill" ? call("kill") : undefined;
					if (first === "interrupt") interrupt.abort();
					else if (first === "parent-user") abort.abort("user");
					else if (first === "parent-default") abort.abort();
					const result = await running.promise;
					await firstRequest;
					await lateRequest.promise;
					assert.equal(result.status, expectedStatus);
					assert.equal(result.cause, parentCancelled ? "abort" : undefined);
					if (parentCancelled) assert.match(result.envelope, /Run cancelled by parent/);
					else
						assert.equal(
							result.envelope,
							first === "kill" ? "Killed. This child cannot be resumed." : "Interrupted",
						);
					assert.equal(control.native.listChildren()[0]?.status, "interrupted");
					assert.equal(control.findChild(path)?.status, expectedStatus);
					const status = await call("status");
					assert.ok(text(status).includes(`Status: ${expectedStatus}`));
					if (first !== "kill") assert.doesNotMatch(text(status), /killed|cannot be resumed/i);
					assert.equal(status.details.statusGroups?.[0]?.children[0]?.status, expectedStatus);
					assert.equal((await call("kill")).isError, true);
					assert.equal(control.findChild(path)?.status, expectedStatus);
				} finally {
					gate.resolve();
					await running.promise;
					await lateRequest.promise;
				}
			},
		);
	}
}

// PR #2974: a kill accepted before parent abort must keep its terminal classification.
test.each(["id", "runId"] as const)("capacity-wait kill via %s survives a later parent abort", async (field) => {
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
	const ctx = context(cwd);
	const launch = execute.execute(
		"kill-before-parent",
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
		const killed = execute.execute(
			"kill-before-parent",
			{ action: "kill", [field]: waiting.path },
			new AbortController().signal,
			undefined,
			ctx,
		);
		abort.abort();
		assert.notEqual((await killed).isError, true);
		await launch;
		await waitUntil(() => terminal.length === 5);
		const result = terminal.find((child) => child.task === "hold 4")!;
		assert.equal(result.status, "killed");
		assert.equal(result.cause, undefined);
		assert.equal(result.envelope, "Killed. This child cannot be resumed.");
		assert.equal(control.findChild(waiting.path)?.status, "killed");
		assert.equal(control.findChild(waiting.path)?.loaded, false);
		assert.ok(terminal.filter((child) => child !== result).every((child) => child.cause === "abort"));
		const repeated = await execute.execute(
			"repeat-kill",
			{ action: "kill", [field]: waiting.path },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(repeated.isError, true);
	} finally {
		abort.abort();
		gate.resolve();
		await launch;
	}
});

for (const cause of ["parent-default", "parent-user", "owner-close"] as const) {
	test.each([false, true])(`${cause} at capacity preserves abort (late kill: %s)`, async (lateKill) => {
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
			if (lateKill)
				await execute.execute(
					"late-kill",
					{ action: "kill", id: waiting.path },
					new AbortController().signal,
					undefined,
					ctx,
				);
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
