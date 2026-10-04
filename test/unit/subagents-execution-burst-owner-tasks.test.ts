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

function harness(runSync: SubagentExecutorRuntimeDeps["runSync"], defaultContext?: "fork") {
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
		config: { parallel: { concurrency: 4, maxTasks: 50 } } as ExecutorDeps["config"],
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
