import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
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

function harness(runSync: SubagentExecutorRuntimeDeps["runSync"], defaultContext?: "fork", concurrency = 4) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-burst-owner-"));
	const parent = join(cwd, "parent.jsonl");
	writeFileSync(parent, "");
	const sessionId = `burst-owner-${++sessions}`;
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId }, authorizeLaunch() {} });
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: false,
		ui: {},
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => parent,
			getSessionId: () => sessionId,
			getLeafId: () => "parent-leaf",
			getEntries: () => [],
			openSession: () => ({
				createBranchedSession: () => {
					const fork = join(cwd, `fork-${++sessions}.jsonl`);
					writeFileSync(fork, "");
					return fork;
				},
			}),
		},
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
			events: { on: () => () => {}, emit: () => {} },
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
		discoverAgents: () => ({ agents: [{ ...agent(), defaultContext }] }),
		runtime: { runSync },
	});
	cleanups.push(async () => {
		await host.close("session-close");
		rmSync(cwd, { recursive: true, force: true });
	});
	return {
		call: (id: string, params: SubagentParamsLike): Promise<SubagentToolResult> =>
			executor.execute(id, params, new AbortController().signal, undefined, ctx),
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

test("coalesced SINGLE foreground calls keep their wait policy and each caller gets only its own settled result (#3427)", async () => {
	const { call } = harness(async (_cwd, _agents, _agent, task) => childResult(task));
	const tasks = ["A", "B", "C"];

	const results = await Promise.all(
		tasks.map((task, index) => call(`call-${index}`, { agent: "echo", task, wait: { kind: "foreground" } })),
	);

	const taskIds = new Set<string>();
	for (const [index, result] of results.entries()) {
		const observation = single(result).observation;
		assert.equal(observation.kind, "settled", "foreground wait must not yield as default-background");
		taskIds.add(observation.taskId);
		assert.deepEqual(
			result.details?.taskRecords?.map((record) => record.ref.taskId),
			[observation.taskId],
			"a caller sees only its own task record",
		);
		const output = text(result);
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

test("coalesced calls with different wait policies are not merged, so each keeps its own policy (#3427)", async () => {
	const releaseForeground = Promise.withResolvers<void>();
	const { call } = harness(async (_cwd, _agents, _agent, task) => {
		if (task === "foreground") await releaseForeground.promise;
		return childResult(task);
	});
	cleanups.push(() => releaseForeground.resolve());

	const foreground = call("call-foreground", {
		agent: "echo",
		task: "foreground",
		wait: { kind: "foreground", budgetMs: 60_000 },
	});
	const background = await Promise.all([
		call("call-background", { agent: "echo", task: "background", wait: { kind: "background" } }),
	]);

	const yielded = single(background[0]!).observation;
	assert.deepEqual(yielded.kind === "yielded" && yielded.reason, "explicit");
	releaseForeground.resolve();
	const settled = single(await foreground).observation;
	assert.equal(settled.kind, "settled");
	assert.equal(
		(await call("call-after", { agent: "echo", task: "after", wait: { kind: "foreground" } })).isError,
		undefined,
	);
});

test("a coalesced PARALLEL call receives only its own slots next to a SINGLE call (#3427)", async () => {
	const { call } = harness(async (_cwd, _agents, _agent, task) => childResult(task));
	const wait = { kind: "foreground" } as const;

	const [first, second] = await Promise.all([
		call("call-parallel", {
			tasks: [
				{ agent: "echo", task: "P1" },
				{ agent: "echo", task: "P2" },
			],
			wait,
		}),
		call("call-single", { agent: "echo", task: "S1", wait }),
	]);

	const slots = parallel(first).slots;
	assert.deepEqual(
		slots.map((slot) => slot.ordinal),
		[0, 1],
	);
	assert.equal(first.details?.taskRecords?.length, 2);
	assert.match(text(first), /output:P1/);
	assert.match(text(first), /output:P2/);
	assert.doesNotMatch(text(first), /output:S1/);
	assert.equal(single(second).observation.kind, "settled");
	assert.match(text(second), /output:S1/);
	assert.doesNotMatch(text(second), /output:P[12]/);
});

test("coalesced caller receipts preserve inferred default-fork context (#3427)", async () => {
	const { call } = harness(async (_cwd, _agents, _agent, task) => childResult(task), "fork");
	const solo = await call("solo", { agent: "echo", task: "solo", wait: { kind: "foreground" } });
	assert.equal(solo.details?.context, "fork");
	const results = await Promise.all(
		["A", "B"].map((task) => call(task, { agent: "echo", task, wait: { kind: "foreground" } })),
	);
	for (const result of results) {
		assert.equal(single(result).observation.kind, "settled");
		assert.equal(result.details?.context, "fork");
	}
});

test("mixed-wait burst children share cap 2 even after background observations yield (#3427)", async () => {
	const tasks = ["B1", "B2", "F1", "F2"];
	const gates = new Map(tasks.map((task) => [task, Promise.withResolvers<void>()]));
	const started = new Map(tasks.map((task) => [task, Promise.withResolvers<void>()]));
	const finished = new Map(tasks.map((task) => [task, Promise.withResolvers<void>()]));
	let active = 0;
	let peak = 0;
	const { call } = harness(async (_cwd, _agents, _agent, task) => {
		active++;
		peak = Math.max(peak, active);
		started.get(task)!.resolve();
		try {
			await gates.get(task)!.promise;
			return childResult(task);
		} finally {
			active--;
			finished.get(task)!.resolve();
		}
	});
	cleanups.push(() => {
		for (const gate of gates.values()) gate.resolve();
	});
	const calls = tasks.map((task) =>
		call(task, {
			agent: "echo",
			task,
			concurrency: 2,
			wait: task.startsWith("B") ? { kind: "background" } : { kind: "foreground" },
		}),
	);
	let foregroundSettled = false;
	void Promise.all(calls.slice(2)).then(() => {
		foregroundSettled = true;
	});
	const background = await Promise.all(calls.slice(0, 2));
	for (const result of background) {
		const observation = single(result).observation;
		assert.equal(observation.kind === "yielded" && observation.reason, "explicit");
		assert.deepEqual(
			result.details?.taskRecords?.map((record) => record.ref.taskId),
			[observation.taskId],
		);
	}
	await Promise.all([started.get("B1")!.promise, started.get("B2")!.promise]);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(peak, 2, "yielded background children must retain their execution slots across wait groups");
	assert.equal(active, 2);
	assert.equal(foregroundSettled, false, "background receipts do not wait for foreground completion");
	gates.get("B1")!.resolve();
	await started.get("F1")!.promise;
	assert.equal(active, 2, "a queued foreground child starts only after an execution ends");
	gates.get("B2")!.resolve();
	await started.get("F2")!.promise;
	gates.get("F1")!.resolve();
	gates.get("F2")!.resolve();
	const foreground = await Promise.all(calls.slice(2));
	for (const [index, result] of foreground.entries()) {
		assert.equal(single(result).observation.kind, "settled");
		assert.match(text(result), new RegExp(`output:F${index + 1}\\b`));
		assert.doesNotMatch(text(result), new RegExp(`output:F${2 - index}\\b|output:B[12]\\b`));
	}
	await Promise.all([...finished.values()].map((value) => value.promise));
	assert.equal(peak, 2);
	assert.equal(active, 0);
});

test("same-policy burst children keep cap 2 and caller-specific results (#3427)", async () => {
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
	const calls = ["A", "B", "C", "D"].map((task) =>
		call(task, { agent: "echo", task, concurrency: 2, wait: { kind: "foreground" } }),
	);
	await firstPairStarted.promise;
	assert.equal(active, 2);
	release.resolve();
	const results = await Promise.all(calls);
	for (const [index, result] of results.entries()) {
		assert.equal(single(result).observation.kind, "settled");
		assert.match(text(result), new RegExp(`output:${["A", "B", "C", "D"][index]}\\b`));
		assert.equal(result.details?.taskRecords?.length, 1);
	}
	assert.equal(launches, 4);
	assert.equal(peak, 2);
	assert.equal(active, 0);
});

test("singleton wait groups share the settings cap while unbounded foreground waits do not block background admission (#3427)", async () => {
	const release = Promise.withResolvers<void>();
	const launched: string[] = [];
	const { call } = harness(
		async (_cwd, _agents, _agent, task) => {
			launched.push(task);
			if (task === "foreground") await release.promise;
			return childResult(task);
		},
		undefined,
		1,
	);
	cleanups.push(() => release.resolve());
	const foreground = call("foreground", { agent: "echo", task: "foreground", wait: { kind: "foreground" } });
	const background = await call("background", { agent: "echo", task: "background", wait: { kind: "background" } });
	assert.equal(single(background).observation.kind, "yielded");
	assert.deepEqual(launched, ["foreground"], "background is admitted but cannot execute before foreground exits");
	release.resolve();
	assert.equal(single(await foreground).observation.kind, "settled");
	assert.deepEqual(launched, ["foreground", "background"]);
});
