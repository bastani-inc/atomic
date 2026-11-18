import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type {
	ModelParallelResponse,
	ModelSingleResponse,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { ExtensionContext } from "../../packages/coding-agent/src/index.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
	SubagentParamsLike,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import type { SingleResult, SubagentToolResult } from "../../packages/subagents/src/shared/types.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function agent(): AgentConfig {
	return {
		name: "echo",
		description: "echo test agent",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "You are a test agent.",
		source: "project",
		filePath: "/tmp/echo.md",
	};
}

function childResult(task: string): SingleResult {
	return { agent: "echo", task, status: "ok", messages: [], usage, finalOutput: `output:${task}` };
}

const cleanups: Array<() => Promise<void> | void> = [];
let sessions = 0;

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

function harness(
	runSync: SubagentExecutorRuntimeDeps["runSync"],
	defaultContext?: "fork",
	concurrency = 4,
	hooks?: {
		beforeDiscover?: (callIndex: number) => Promise<void> | void;
		onEventEmit?: (eventName: string, payload: unknown) => void;
	},
) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-burst-owner-"));
	const parentManager = SessionManager.inMemory(cwd);
	const ready = parentManager.appendMessage({ role: "user", content: "parent context", timestamp: Date.now() });
	const sessionId = `burst-owner-${++sessions}`;
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId }, authorizeLaunch() {} });
	let discoveryCall = 0;
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
		pi: {
			events: {
				on: () => () => {},
				emit: (eventName: string, payload: unknown) => hooks?.onEventEmit?.(eventName, payload),
			},
			getSessionName: () => "parent",
		} as unknown as ExecutorDeps["pi"],
		state: {
			baseCwd: "",
			currentSessionId: null,
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
		},
		config: { parallel: { concurrency, maxTasks: 50 } } as ExecutorDeps["config"],
		tempArtifactsDir: join(cwd, "artifacts"),
		getSubagentSessionRoot: () => join(cwd, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: async () => {
			await hooks?.beforeDiscover?.(discoveryCall++);
			return { agents: [{ ...agent(), defaultContext }] };
		},
		runtime: { runSync },
	});
	cleanups.push(async () => {
		await host.close("session-close");
		rmSync(cwd, { recursive: true, force: true });
	});
	return {
		cwd,
		call: (id: string, params: SubagentParamsLike): Promise<SubagentToolResult> =>
			ready.then(() => executor.execute(id, params, new AbortController().signal, undefined, ctx)),
	};
}

function text(result: SubagentToolResult): string {
	return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

function single(result: SubagentToolResult): Extract<ModelSingleResponse, { kind: "admitted" }> {
	const response = result.details?.taskResponse;
	assert.equal(response?.kind, "admitted", text(result));
	assert.ok(response?.kind === "admitted");
	return response;
}

function parallel(result: SubagentToolResult): ModelParallelResponse {
	const response = result.details?.taskResponse;
	assert.equal(response?.kind, "parallel", text(result));
	assert.ok(response?.kind === "parallel");
	return response;
}

/** What `subagent({ action: "wait", id })` returns once the launched child settled. */
async function settledOutput(call: ReturnType<typeof harness>["call"], taskId: string): Promise<string> {
	const waited = await call(`wait-${taskId}`, { action: "wait", id: taskId });
	const observed = waited.details?.taskResponse;
	assert.ok(observed?.kind === "admitted" && observed.observation.kind === "settled", text(waited));
	return text(waited);
}

test("coalesced SINGLE calls each get only their own task, and waiting on it only its own result (#3427)", async () => {
	const { call } = harness(async (_cwd, _agents, _agent, task) => childResult(task));
	const tasks = ["A", "B", "C"];

	const results = await Promise.all(tasks.map((task, index) => call(`call-${index}`, { agent: "echo", task })));

	const taskIds = new Set<string>();
	for (const [index, result] of results.entries()) {
		const observation = single(result).observation;
		taskIds.add(observation.taskId);
		assert.deepEqual(
			result.details?.taskRecords?.map((record) => record.ref.taskId),
			[observation.taskId],
			"a caller sees only its own task record",
		);
		const output = await settledOutput(call, observation.taskId);
		assert.match(output, new RegExp(`output:${tasks[index]}\\b`));
		for (const sibling of tasks.filter((task) => task !== tasks[index])) {
			assert.doesNotMatch(output, new RegExp(`output:${sibling}\\b`));
		}
	}
	assert.equal(taskIds.size, 3);
});

test("coalesced SINGLE calls without a wait policy each receive their own background receipt (#3427)", async () => {
	const release = Promise.withResolvers<void>();
	const { call } = harness(async (_cwd, _agents, _agent, task) => {
		await release.promise;
		return childResult(task);
	});
	cleanups.push(() => release.resolve());

	const results = await Promise.all(
		["A", "B", "C"].map((task, index) => call(`call-${index}`, { agent: "echo", task })),
	);

	const taskIds = results.map((result) => {
		const observation = single(result).observation;
		assert.deepEqual(observation.kind === "yielded" && observation.reason, "default-background");
		assert.equal(result.details?.taskRecords?.length, 1);
		return observation.taskId;
	});
	assert.equal(new Set(taskIds).size, 3);
});

test("a coalesced PARALLEL call receives only its own slots next to a SINGLE call (#3427)", async () => {
	const { call } = harness(async (_cwd, _agents, _agent, task) => childResult(task));

	const [first, second] = await Promise.all([
		call("call-parallel", {
			tasks: [
				{ agent: "echo", task: "P1" },
				{ agent: "echo", task: "P2" },
			],
		}),
		call("call-single", { agent: "echo", task: "S1" }),
	]);

	const slots = parallel(first).slots;
	assert.deepEqual(
		slots.map((slot) => slot.ordinal),
		[0, 1],
	);
	assert.equal(first.details?.taskRecords?.length, 2);
	const outputs = await Promise.all(
		slots.map((slot) => {
			assert.equal(slot.outcome.kind, "admitted");
			assert.ok(slot.outcome.kind === "admitted");
			return settledOutput(call, slot.outcome.observation.taskId);
		}),
	);
	assert.match(outputs[0]!, /output:P1/);
	assert.match(outputs[1]!, /output:P2/);
	const own = await settledOutput(call, single(second).observation.taskId);
	assert.match(own, /output:S1/);
	assert.doesNotMatch(own, /output:P[12]/);
});

test("coalesced caller receipts preserve inferred default-fork context (#3427)", async () => {
	const { call } = harness(async (_cwd, _agents, _agent, task) => childResult(task), "fork");
	const solo = await call("solo", { agent: "echo", task: "solo" });
	assert.equal(solo.details?.context, "fork");
	const results = await Promise.all(["A", "B"].map((task) => call(task, { agent: "echo", task })));
	for (const result of results) {
		assert.equal(single(result).observation.kind, "yielded");
		assert.equal(result.details?.context, "fork");
	}
});

test("coalesced burst children keep cap 2, return at once, and keep caller-specific results (#3427)", async () => {
	const firstPairStarted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let active = 0;
	let peak = 0;
	let launches = 0;
	const { call } = harness(async (_cwd, _agents, _agent, task) => {
		active++;
		peak = Math.max(peak, active);
		if (++launches === 2) firstPairStarted.resolve();
		await release.promise;
		active--;
		return childResult(task);
	});
	cleanups.push(() => release.resolve());
	const tasks = ["A", "B", "C", "D"];
	const receipts = await Promise.all(tasks.map((task) => call(task, { agent: "echo", task, concurrency: 2 })));
	await firstPairStarted.promise;
	assert.equal(active, 2);
	release.resolve();
	for (const [index, receipt] of receipts.entries()) {
		assert.equal(receipt.details?.taskRecords?.length, 1);
		const output = await settledOutput(call, single(receipt).observation.taskId);
		assert.match(output, new RegExp(`output:${tasks[index]}\\b`));
	}
	assert.equal(launches, 4);
	assert.equal(peak, 2);
	assert.equal(active, 0);
});

test("coalesced calls share the settings cap: a later call is admitted at once but runs after the earlier exits (#3427)", async () => {
	const release = Promise.withResolvers<void>();
	const launched: string[] = [];
	const { call } = harness(
		async (_cwd, _agents, _agent, task) => {
			launched.push(task);
			if (task === "first") await release.promise;
			return childResult(task);
		},
		undefined,
		1,
	);
	cleanups.push(() => release.resolve());
	const [first, later] = await Promise.all([
		call("first", { agent: "echo", task: "first" }),
		call("later", { agent: "echo", task: "later" }),
	]);
	assert.equal(single(later).observation.kind, "yielded");
	assert.deepEqual(launched, ["first"], "the later call is admitted but cannot execute before the first exits");
	release.resolve();
	assert.match(await settledOutput(call, single(first).observation.taskId), /output:first/);
	assert.match(await settledOutput(call, single(later).observation.taskId), /output:later/);
	assert.deepEqual(launched, ["first", "later"]);
});

test("each SINGLE call's progress stays run-isolated without overwriting project progress (#3427)", async () => {
	const release = Promise.withResolvers<void>();
	const bothStarted = Promise.withResolvers<void>();
	const progressPaths: string[] = [];
	let active = 0;
	let peak = 0;
	const { call, cwd } = harness(
		async (_cwd, _agents, _agent, task, options) => {
			assert.ok(options.progressPath);
			progressPaths.push(options.progressPath);
			assert.ok(readFileSync(options.progressPath, "utf8").length > 0);
			active++;
			peak = Math.max(peak, active);
			if (active === 2) bothStarted.resolve();
			await release.promise;
			active--;
			return childResult(task);
		},
		undefined,
		2,
	);
	cleanups.push(() => release.resolve());
	const sentinel = "Project progress must survive.\n";
	const projectProgress = join(cwd, "progress.md");
	writeFileSync(projectProgress, sentinel);
	const first = await call("first", { agent: "echo", task: "first", progress: true });
	const second = await call("second", { agent: "echo", task: "second", progress: true });
	await bothStarted.promise;
	assert.equal(readFileSync(projectProgress, "utf8"), sentinel);
	release.resolve();
	const own = await settledOutput(call, single(first).observation.taskId);
	assert.match(own, /output:first/);
	assert.doesNotMatch(own, /output:second/);
	assert.match(await settledOutput(call, single(second).observation.taskId), /output:second/);
	assert.equal(progressPaths.length, 2);
	assert.equal(new Set(progressPaths).size, 2);
	for (const progressPath of progressPaths) {
		assert.notEqual(progressPath, projectProgress);
		assert.match(progressPath, /[\\/]progress[\\/][^\\/]+[\\/]progress\.md$/);
	}
	assert.equal(peak, 2);
	assert.equal(readFileSync(projectProgress, "utf8"), sentinel);
});

test("subagent heartbeatMs reaches each child's task, per call and per parallel task, including coalesced calls", async () => {
	const { call } = harness(async (_cwd, _agents, _agent, task) => childResult(task));
	const [first, second, parallelCall] = await Promise.all([
		call("call-a", { agent: "echo", task: "A", heartbeatMs: 120_000 }),
		call("call-b", { agent: "echo", task: "B", heartbeatMs: 0 }),
		call("call-p", {
			tasks: [
				{ agent: "echo", task: "P1", heartbeatMs: 600_000 },
				{ agent: "echo", task: "P2" },
			],
			heartbeatMs: 300_000,
		}),
	]);
	assert.deepEqual(
		first.details?.taskRecords?.map((record) => record.heartbeatMs),
		[120_000],
	);
	assert.deepEqual(
		second.details?.taskRecords?.map((record) => record.heartbeatMs),
		[0],
	);
	assert.deepEqual(
		parallelCall.details?.taskRecords?.map((record) => [record.title, record.heartbeatMs]),
		[
			["P1", 600_000],
			["P2", 300_000],
		],
	);
	const plain = await call("call-plain", { agent: "echo", task: "plain" });
	assert.equal(plain.details?.taskRecords?.[0]?.heartbeatMs, undefined, "omitted uses the owner default");
});

test("an out-of-range subagent heartbeatMs is refused before any child launches", async () => {
	let launches = 0;
	const { call } = harness(async (_cwd, _agents, _agent, task) => {
		launches++;
		return childResult(task);
	});
	const single = await call("call-single", { agent: "echo", task: "A", heartbeatMs: 5000 });
	assert.equal(single.isError, true);
	assert.match(text(single), /^Invalid heartbeatMs 5000: use 0 to disable task heartbeats/);
	const parallelCall = await call("call-parallel", {
		tasks: [
			{ agent: "echo", task: "P1" },
			{ agent: "echo", task: "P2", heartbeatMs: Number.NaN },
		],
	});
	assert.equal(parallelCall.isError, true);
	assert.match(text(parallelCall), /^Invalid tasks\[1\]\.heartbeatMs NaN/);
	assert.equal(launches, 0);
});
