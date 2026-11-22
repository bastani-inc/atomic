import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@bastani/atomic-tui";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type {
	ModelParallelResponse,
	ModelSingleResponse,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { ExtensionContext } from "../../packages/coding-agent/src/index.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import {
	renderSubagentToolCall,
	renderSubagentToolResult,
} from "../../packages/subagents/src/extension/tool-rendering.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import { getBurstDisplay } from "../../packages/subagents/src/runs/foreground/subagent-executor-burst-display.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
	SubagentParamsLike,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import type { SingleResult, SubagentToolResult } from "../../packages/subagents/src/shared/types.js";
import { git } from "../helpers/workspace-repos.js";
import { theme } from "./subagents-render-stability-helpers.js";

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
		maxTasks?: number;
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
		config: { parallel: { concurrency, maxTasks: hooks?.maxTasks ?? 50 } } as ExecutorDeps["config"],
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
		call: (
			id: string,
			params: SubagentParamsLike,
			signal = new AbortController().signal,
		): Promise<SubagentToolResult> => ready.then(() => executor.execute(id, params, signal, undefined, ctx)),
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

test("a launch naming an unknown agent fails alone: a sibling launch in the same message still runs and hears nothing of it (#3427)", async () => {
	const launched: string[] = [];
	const { call } = harness(async (_cwd, _agents, _agent, task) => {
		launched.push(task);
		return childResult(task);
	});
	const [bad, good, parallelBad] = await Promise.all([
		call("bad", { agent: "nonexistent", task: "bad" }),
		call("good", { agent: "echo", task: "good" }),
		call("parallel-bad", {
			tasks: [
				{ agent: "echo", task: "fine" },
				{ agent: "missing", task: "unknown" },
			],
		}),
	]);
	assert.equal(bad.isError, true);
	assert.equal(text(bad), "Unknown agent: nonexistent");
	assert.equal(parallelBad.isError, true);
	assert.equal(text(parallelBad), "Unknown agent: missing (task 2)", "the index is the caller's own task");
	assert.notEqual(good.isError, true);
	assert.doesNotMatch(text(good), /nonexistent|missing/);
	assert.match(await settledOutput(call, single(good).observation.taskId), /output:good/);
	assert.deepEqual(launched, ["good"]);
	for (const id of ["bad", "good", "parallel-bad"])
		assert.equal(getBurstDisplay(id), undefined, `${id} renders as its own call, not as part of the failed burst`);
});

test("a launch whose output setup fails on its own fails alone, and its sibling launches once (#3427)", async () => {
	const launched: string[] = [];
	const { call } = harness(async (_cwd, _agents, _agent, task) => {
		launched.push(task);
		return childResult(task);
	});
	const [bad, good] = await Promise.all([
		call("output-bad", { agent: "echo", task: "bad", outputMode: "file-only" }),
		call("output-good", { agent: "echo", task: "good" }),
	]);
	assert.equal(bad.isError, true);
	assert.match(text(bad), /^Single run \(echo\) sets outputMode: "file-only" but does not configure an output file/);
	assert.notEqual(good.isError, true, "the valid call does not inherit its sibling's setup error");
	assert.match(await settledOutput(call, single(good).observation.taskId), /output:good/);
	assert.deepEqual(launched, ["good"]);
});

test("when every launch in a message fails on its own, each gets its own error and the next launch still runs (#3427)", async () => {
	const launched: string[] = [];
	const { call } = harness(async (_cwd, _agents, _agent, task) => {
		launched.push(task);
		return childResult(task);
	});
	const [bad, invalidCount] = await Promise.all([
		call("all-bad", { agent: "missing", task: "bad" }),
		call("all-count", { tasks: [{ agent: "echo", task: "invalid", count: 0 }] }),
	]);
	assert.equal(text(bad), "Unknown agent: missing");
	assert.equal(text(invalidCount), "tasks[0].count must be an integer >= 1");
	assert.deepEqual(launched, []);
	const later = await call("after-all-bad", { agent: "echo", task: "later" });
	assert.match(await settledOutput(call, single(later).observation.taskId), /output:later/);
	assert.deepEqual(launched, ["later"]);
});

test.each([false, true])(
	"a parallel launch that fails on its own beside a valid sibling shows its own error on its card (expanded: %s) (#3427)",
	async (expanded) => {
		initTheme("dark", false);
		const { call } = harness(async (_cwd, _agents, _agent, task) => childResult(task));
		const args = {
			tasks: [
				{ agent: "echo", task: "fine" },
				{ agent: "missing", task: "unknown" },
			],
		};
		const [bad, good] = await Promise.all([
			call("render-parallel-bad", args),
			call("render-sibling-good", { agent: "echo", task: "good" }),
		]);
		assert.equal(text(bad), "Unknown agent: missing (task 2)");
		assert.notEqual(good.isError, true);
		const context = { toolCallId: "render-parallel-bad", state: {}, args, isError: true } as Parameters<
			typeof renderSubagentToolCall
		>[2];
		renderSubagentToolCall(args, theme as never, context);
		const card = renderSubagentToolResult(bad, { expanded, isPartial: false }, theme as never, context);
		const rendered = card.render(180).join("\n");
		assert.match(rendered, /Unknown agent: missing \(task 2\)/);
		assert.doesNotMatch(rendered, /Stopped/);
		for (const width of [12, 24, 40])
			assert.ok(
				card.render(width).every((line) => visibleWidth(line) <= width),
				`the card fits ${width} columns`,
			);
	},
);

test.each([undefined, false, "named on third task", "shared named"] as const)(
	"duplicate outputs fail only their own call with worktree: %s, and a valid sibling launches once (#3427)",
	async (scenario) => {
		const launched: string[] = [];
		const { call, cwd } = harness(async (_cwd, _agents, _agent, task) => {
			launched.push(task);
			return childResult(task);
		});
		const named = { branch: "output-work" };
		if (typeof scenario === "string") {
			git(cwd, "init", "-q", "-b", "main");
			git(cwd, "commit", "--allow-empty", "-qm", "init");
		}
		const worktree = typeof scenario === "string" ? false : scenario;
		const badArgs: SubagentParamsLike = {
			worktree: scenario === "shared named" ? named : worktree,
			tasks: [
				{ agent: "echo", task: "bad-1", output: "same.md" },
				{ agent: "echo", task: "bad-2", output: "same.md" },
				...(scenario === "named on third task" ? [{ agent: "echo", task: "third", worktree: named }] : []),
			],
		};
		const alone = await call("duplicate-alone", badArgs);
		assert.equal(alone.isError, true);
		assert.match(text(alone), /resolve output to the same path/);
		const [good, bad] = await Promise.all([
			call("duplicate-good", { agent: "echo", task: "good", worktree }),
			call("duplicate-bad", badArgs),
		]);
		assert.equal(bad.isError, true);
		assert.equal(text(bad), text(alone), "the error names the call's own task numbers and actual output path");
		assert.notEqual(good.isError, true, "a valid sibling does not inherit a call's own duplicate-output error");
		assert.match(await settledOutput(call, single(good).observation.taskId), /output:good/);
		assert.deepEqual(launched, ["good"]);
	},
);

test.each([
	["absolute", 1],
	["absolute", 3],
	["relative", 1],
	["mixed absolute", 1],
] as const)(
	"only eligible calls count toward the combined limit with %s outputs and %i valid siblings (#3427)",
	async (pathKind, valid) => {
		const launched: string[] = [];
		const { cwd, call } = harness(
			async (_cwd, _agents, _agent, task) => {
				launched.push(task);
				return childResult(task);
			},
			undefined,
			4,
			{ maxTasks: 2 },
		);
		git(cwd, "init", "-q", "-b", "main");
		git(cwd, "commit", "--allow-empty", "-qm", "init");
		const output = pathKind === "relative" ? "same.md" : join(cwd, "same.md");
		const arrayChild = { agent: "echo", task: "listed", output };
		const conflicting: SubagentParamsLike =
			pathKind === "mixed absolute"
				? { agent: "echo", task: "top", output, tasks: [arrayChild] }
				: { tasks: [{ ...arrayChild, count: 2 }] };
		const [repeated, ...rest] = await Promise.all([
			call("repeated", { ...conflicting, worktree: true }),
			...Array.from({ length: valid }, (_, i) =>
				call(`good-${i}`, { worktree: true, agent: "echo", task: `good-${i}` }),
			),
		]);
		assert.equal(repeated.isError, true);
		if (pathKind === "relative") {
			// These tasks would each have a worktree of their own, so the paths do not collide.
			for (const result of [repeated, ...rest])
				assert.match(text(result), /Too many parallel tasks \(3 after count expansion\)/);
			assert.deepEqual(launched, []);
			return;
		}
		assert.match(text(repeated), /Parallel tasks 1 .* and 2 .* resolve output to the same path/);
		if (valid === 1) {
			assert.match(await settledOutput(call, single(rest[0]!).observation.taskId), /output:good-0/);
			assert.deepEqual(launched, ["good-0"]);
		} else {
			for (const result of rest) {
				assert.equal(result.isError, true);
				assert.match(text(result), /Too many parallel tasks \(3 after count expansion\)/);
			}
			assert.deepEqual(launched, []);
		}
	},
);

test.each([1, 2])(
	"a mixed call keeps its top-level child and %i listed children after a sibling fails (#3427)",
	async (count) => {
		const launched: string[] = [];
		const { call, cwd } = harness(
			async (_cwd, _agents, _agent, task) => {
				launched.push(task);
				return childResult(task);
			},
			undefined,
			4,
			{ maxTasks: 2 },
		);
		git(cwd, "init", "-q", "-b", "main");
		git(cwd, "commit", "--allow-empty", "-qm", "init");
		const [bad, mixed] = await Promise.all([
			call("named-duplicate", {
				worktree: { branch: "output-work" },
				tasks: [{ agent: "echo", task: "bad", count: 2, output: "same.md" }],
			}),
			call("mixed", { agent: "echo", task: "top", tasks: [{ agent: "echo", task: "listed", count }] }),
		]);
		assert.match(text(bad), /resolve output to the same path/);
		if (count === 2) {
			assert.equal(mixed.isError, true);
			assert.match(text(mixed), /Too many parallel tasks \(3 after count expansion\)/);
			assert.deepEqual(launched, []);
			return;
		}
		const slots = parallel(mixed).slots;
		assert.equal(slots.length, 2);
		for (const [index, slot] of slots.entries()) {
			assert.ok(slot.outcome.kind === "admitted");
			assert.ok(
				(await settledOutput(call, slot.outcome.observation.taskId)).includes(
					`output:${index === 0 ? "top" : "listed"}`,
				),
			);
		}
		assert.deepEqual(launched.sort(), ["listed", "top"]);
	},
);

test.each(["worktree", "share", "includeProgress"] as const)(
	"sibling calls launch together when one sets %s to false and the other leaves it out (#3427)",
	async (field) => {
		const launched: string[] = [];
		const { call } = harness(async (_cwd, _agents, _agent, task) => {
			launched.push(task);
			return childResult(task);
		});
		const [explicit, omitted] = await Promise.all([
			call(`false-${field}`, { agent: "echo", task: "explicit", [field]: false }),
			call(`omitted-${field}`, { agent: "echo", task: "omitted" }),
		]);
		assert.notEqual(explicit.isError, true, text(explicit));
		assert.notEqual(omitted.isError, true, text(omitted));
		assert.match(await settledOutput(call, single(explicit).observation.taskId), /output:explicit/);
		assert.match(await settledOutput(call, single(omitted).observation.taskId), /output:omitted/);
		assert.deepEqual(launched.sort(), ["explicit", "omitted"]);
	},
);

test("sibling calls launch together when one sets share to true and the other leaves it out, since share has no effect", async () => {
	const launched: string[] = [];
	const { call } = harness(async (_cwd, _agents, _agent, task) => {
		launched.push(task);
		return childResult(task);
	});
	const [shared, omitted] = await Promise.all([
		call("true-share", { agent: "echo", task: "shared", share: true }),
		call("omitted-share", { agent: "echo", task: "omitted" }),
	]);
	assert.notEqual(shared.isError, true, text(shared));
	assert.notEqual(omitted.isError, true, text(omitted));
	assert.match(await settledOutput(call, single(shared).observation.taskId), /output:shared/);
	assert.match(await settledOutput(call, single(omitted).observation.taskId), /output:omitted/);
	assert.deepEqual(launched.sort(), ["omitted", "shared"]);
});

test("a sibling aborted while its message's failed merged run is checked never launches, and the next launch still runs (#3427)", async () => {
	const launched: string[] = [];
	const checking = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const { call } = harness(
		async (_cwd, _agents, _agent, task) => {
			launched.push(task);
			return childResult(task);
		},
		undefined,
		4,
		{
			// Discovery 0 is the merged run's; the next ones check each launch on its own.
			beforeDiscover: async (index) => {
				if (index !== 1) return;
				checking.resolve();
				await resume.promise;
			},
		},
	);
	const esc = new AbortController();
	const bad = call("aborted-check-bad", { agent: "missing", task: "bad" });
	const good = assert.rejects(call("aborted-check-good", { agent: "echo", task: "good" }, esc.signal), /abort/i);
	await checking.promise;
	esc.abort();
	resume.resolve();
	assert.equal(text(await bad), "Unknown agent: missing");
	await good;
	assert.deepEqual(launched, []);
	const later = await call("after-aborted-check", { agent: "echo", task: "later" });
	assert.match(await settledOutput(call, single(later).observation.taskId), /output:later/);
	assert.deepEqual(launched, ["later"]);
});

test("sibling calls that merge share one concurrency limit, also when only one of them passes a wait (#5686)", async () => {
	const release = Promise.withResolvers<void>();
	const started: string[] = [];
	const { call } = harness(
		async (_cwd, _agents, _agent, task) => {
			started.push(task);
			await release.promise;
			return childResult(task);
		},
		undefined,
		1,
	);
	cleanups.push(() => release.resolve());
	const outputs = await Promise.all([
		call("with-wait", { agent: "echo", task: "A", wait: { kind: "background" } } as SubagentParamsLike),
		call("without-wait", { agent: "echo", task: "B" }),
	]);
	assert.deepEqual(
		outputs.map((output) => output.isError === true),
		[false, false],
		outputs.map(text).join(" | "),
	);
	const deadline = Date.now() + 500;
	while (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(started, ["A"], "a limit of one starts the second child only once the first ends");
	release.resolve();
	const settled = Date.now() + 10_000;
	while (started.length < 2 && Date.now() < settled) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(started, ["A", "B"]);
});

test.each([
	{ name: "a shared output file", maxTasks: 50, shared: true, error: /same path/ },
	{ name: "the combined task limit", maxTasks: 1, shared: false, error: /Too many parallel tasks/ },
])(
	"sibling calls that can merge still fail together on $name when only one passes a wait (#5686)",
	async ({ maxTasks, shared, error }) => {
		const started: string[] = [];
		const { call, cwd } = harness(
			async (_cwd, _agents, _agent, task) => {
				started.push(task);
				return childResult(task);
			},
			undefined,
			4,
			{ maxTasks },
		);
		const output = shared ? { output: join(cwd, "report.md") } : {};
		// A caller that still passes the removed launch `wait`.
		const withWait = { agent: "echo", task: "A", ...output, wait: { kind: "background" } };
		const answers = await Promise.all([
			call("with-wait", withWait as SubagentParamsLike),
			call("without-wait", { agent: "echo", task: "B", ...output }),
		]);
		for (const answer of answers) {
			assert.equal(answer.isError, true, text(answer));
			assert.match(text(answer), error);
		}
		assert.deepEqual(started, []);
	},
);
