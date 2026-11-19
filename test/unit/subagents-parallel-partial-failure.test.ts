import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@bastani/atomic-tui";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { ModelParallelResponse } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { ExtensionContext } from "../../packages/coding-agent/src/index.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import {
	renderSubagentToolCall,
	renderSubagentToolResult,
} from "../../packages/subagents/src/extension/tool-rendering.js";
import { SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
	SubagentParamsLike,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import type { SingleResult, SubagentToolResult } from "../../packages/subagents/src/shared/types.js";

const AUTH_TIMEOUT = "Supervisor authorization timeout";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

const agent: AgentConfig = {
	name: "echo",
	description: "echo test agent",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	systemPrompt: "You are a test agent.",
	source: "project",
	filePath: "/tmp/echo.md",
};

/** A parallel executor whose supervisor authorization fails for the children `failing` names (1-based). */
function harness(options: { host: boolean; failing: ReadonlySet<number> }) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-parallel-partial-"));
	const parentManager = SessionManager.inMemory(cwd);
	const ready = parentManager.appendMessage({ role: "user", content: "parent", timestamp: Date.now() });
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: `partial-${cleanups.length}-${Date.now()}` },
		authorizeLaunch() {},
	});
	const started: string[] = [];
	const runSync: SubagentExecutorRuntimeDeps["runSync"] = async (_cwd, _agents, _agent, task) => {
		started.push(task);
		return { agent: "echo", task, status: "ok", messages: [], usage, finalOutput: `output:${task}` } as SingleResult;
	};
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
		...(options.host ? { getAgentTaskHost: () => host } : {}),
	} as unknown as ExtensionContext;
	const authorizations: string[] = [];
	const executor = createSubagentExecutor({
		pi: {
			events: {
				on: () => () => {},
				emit(channel: string, payload: { childName: string; completion?: Promise<unknown> }) {
					if (channel !== SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT) return;
					authorizations.push(payload.childName);
					const ordinal = Number(payload.childName.split("-").at(-1));
					payload.completion = options.failing.has(ordinal)
						? Promise.reject(new Error(AUTH_TIMEOUT))
						: Promise.resolve({
								capability: `cap-${ordinal}`,
								supervisorSessionId: "parent",
								childName: payload.childName,
							});
				},
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
		config: { parallel: { concurrency: 5, maxTasks: 50 } } as ExecutorDeps["config"],
		tempArtifactsDir: join(cwd, "artifacts"),
		getSubagentSessionRoot: () => join(cwd, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [agent] }),
		runtime: { runSync },
	});
	cleanups.push(async () => {
		await host.close("session-close");
		rmSync(cwd, { recursive: true, force: true });
	});
	const params: SubagentParamsLike = {
		tasks: [1, 2, 3, 4, 5].map((n) => ({ agent: "echo", task: `T${n}` })),
	};
	return {
		host,
		started,
		authorizations,
		params,
		call: (): Promise<SubagentToolResult> =>
			ready.then(() => executor.execute("call-4697", params, new AbortController().signal, undefined, ctx)),
	};
}

const text = (result: SubagentToolResult) =>
	result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

function slots(result: SubagentToolResult): ModelParallelResponse["slots"] {
	const response = result.details?.taskResponse;
	assert.ok(response?.kind === "parallel", text(result));
	return response.slots;
}

test("one child's supervisor authorization timeout is its own outcome; its siblings run and report (#4697)", async () => {
	const h = harness({ host: true, failing: new Set([3]) });
	const result = await h.call();
	assert.equal(h.authorizations.length, 5, "every child asked for authorization");
	assert.notEqual(result.isError, true, "a partial failure is not a failed call");
	const outcomes = slots(result).map((slot) => slot.outcome);
	assert.deepEqual(outcomes[2], {
		kind: "unstarted",
		reason: { kind: "rejected", error: { code: "SpawnFailed", message: AUTH_TIMEOUT } },
	});
	for (const index of [0, 1, 3, 4]) {
		const outcome = outcomes[index]!;
		assert.ok(outcome.kind === "admitted");
		const settled = await h.host.waitForTask(outcome.observation.taskId);
		assert.ok(settled.ok && settled.value.kind === "settled");
		assert.equal(settled.value.result.kind, "completed");
	}
	assert.deepEqual(h.started.sort(), ["T1", "T2", "T4", "T5"]);
	const body = text(result);
	assert.match(body, /1 of 5 children failed to start; the others started/);
	assert.match(body, new RegExp(AUTH_TIMEOUT));
});

test("the call fails only when every child failed to start, and still lists each child's error (#4697)", async () => {
	const h = harness({ host: true, failing: new Set([1, 2, 3, 4, 5]) });
	const result = await h.call();
	assert.equal(result.isError, true);
	assert.deepEqual(h.started, []);
	const outcomes = slots(result).map((slot) => slot.outcome);
	assert.equal(outcomes.length, 5);
	for (const outcome of outcomes)
		assert.ok(
			outcome.kind === "unstarted" &&
				outcome.reason.kind === "rejected" &&
				outcome.reason.error.message === AUTH_TIMEOUT,
		);
	assert.match(text(result), /5 of 5 children failed to start\./);
});

test("without a task host a child's authorization failure is a failed child, not a failed call (#4697)", async () => {
	const partial = await harness({ host: false, failing: new Set([2]) }).call();
	assert.notEqual(partial.isError, true);
	assert.deepEqual(
		partial.details?.results.map((child) => child.status),
		["ok", "error", "ok", "ok", "ok"],
	);
	assert.equal(partial.details?.results[1]?.error, AUTH_TIMEOUT);
	assert.match(text(partial), /^4\/5 succeeded/);
	assert.match(text(partial), /output:T5/);
	assert.match(text(partial), new RegExp(AUTH_TIMEOUT));

	const failed = await harness({ host: false, failing: new Set([1, 2, 3, 4, 5]) }).call();
	assert.equal(failed.isError, true);
	assert.equal(failed.details?.results.length, 5);
	assert.ok(failed.details?.results.every((child) => child.error === AUTH_TIMEOUT));
});

/** Render the call header and result the way the tool card does: the header is drawn after both renderers ran. */
function renderCard(params: SubagentParamsLike, result: SubagentToolResult, expanded: boolean, width: number) {
	initTheme("dark");
	const context = {
		toolCallId: `card-${Math.random()}`,
		state: {},
		invalidate() {},
		isError: result.isError === true,
	};
	renderSubagentToolCall(params, theme, context);
	const body = renderSubagentToolResult(result, { expanded, isPartial: false }, theme, context);
	const lines = body.render(width);
	return { lines, text: lines.map((line) => stripVTControlCharacters(line).trimEnd()).join("\n") };
}

test("partial failure keeps every child row and marks the failed child (#4697)", async () => {
	const h = harness({ host: true, failing: new Set([3]) });
	const result = await h.call();
	const collapsed = renderCard(h.params, result, false, 100).text;
	assert.match(collapsed, /● Agent\(echo · T1\)\n {3}⎿ {2}Done/);
	assert.match(collapsed, /✗ Agent\(echo · T3\)\n {3}⎿ {2}Failed · Supervisor authorization timeout/);
	assert.match(collapsed, /● Agent\(echo · T5\)\n {3}⎿ {2}Done/);
	assert.doesNotMatch(collapsed, /^✗ Supervisor authorization timeout$/m, "no single collapsed error");

	const expanded = renderCard(h.params, result, true, 100).text;
	assert.match(expanded, /✗ Agent\(echo · T3\)\n {3}⎿ {2}Failed · Supervisor authorization timeout/);
	assert.equal((expanded.match(/● Agent\(echo · T\d\)/g) ?? []).length, 4);
});

test("a failed child's error is one truncated line collapsed and wraps in full expanded at narrow widths (#4697)", async () => {
	const h = harness({ host: true, failing: new Set([3]) });
	const result = await h.call();
	for (const width of [12, 24, 40])
		for (const expanded of [false, true]) {
			const { lines, text: rendered } = renderCard(h.params, result, expanded, width);
			assert.ok(
				lines.every((line) => visibleWidth(line) <= width),
				`${expanded ? "expanded" : "collapsed"} lines fit ${width} columns`,
			);
			const errorLines = rendered
				.split("\n")
				.filter((line) => line.includes("Supervisor") || line.includes("timeout") || line.includes("Fail"));
			if (!expanded) {
				const collapsedError = rendered.split("\n").filter((line) => /^ {3}⎿ {2}Fail/.test(line));
				assert.equal(collapsedError.length, 1, `collapsed error stays one line at ${width}`);
				if (width < `   ⎿  Failed · ${AUTH_TIMEOUT}`.length) assert.match(collapsedError[0]!, /…$/);
			} else assert.ok(errorLines.length >= 1);
		}
	const wide = renderCard(h.params, result, true, 24).text;
	assert.match(wide.replace(/\s+/g, " "), /Supervisor authorization timeout/);
});

test("all-success and all-failed parallel cards keep every child block (#4697)", async () => {
	const ok = harness({ host: true, failing: new Set() });
	const okText = renderCard(ok.params, await ok.call(), false, 100).text;
	assert.equal((okText.match(/● Agent\(echo · T\d\)\n {3}⎿ {2}Done/g) ?? []).length, 5);
	assert.doesNotMatch(okText, /Failed|✗/);

	const failed = harness({ host: true, failing: new Set([1, 2, 3, 4, 5]) });
	const failedText = renderCard(failed.params, await failed.call(), false, 100).text;
	assert.equal(
		(failedText.match(/✗ Agent\(echo · T\d\)\n {3}⎿ {2}Failed · Supervisor authorization timeout/g) ?? []).length,
		5,
	);
});

test("without a task host the partial and all-failed cards render per-child blocks, not one error (#4697)", async () => {
	for (const failing of [new Set([2]), new Set([1, 2, 3, 4, 5])]) {
		const h = harness({ host: false, failing });
		const rendered = renderCard(h.params, await h.call(), false, 100).text;
		assert.doesNotMatch(rendered, /^✗ Supervisor authorization timeout$/m);
		assert.match(rendered, /Agent\(echo · T1\)/);
		assert.equal((rendered.match(/● Agent\(echo · T\d\)/g) ?? []).length, failing.size === 5 ? 0 : 4);
	}
});
