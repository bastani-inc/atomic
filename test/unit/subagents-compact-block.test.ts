import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, stripTerminalSequences, Text, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.ts";
import type { ModelParallelResponse, TaskId, WaitId } from "../../packages/coding-agent/src/core/tasks/contracts.ts";
import { isToolBlock } from "../../packages/coding-agent/src/modes/interactive/components/tool-block.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import {
	renderContactSupervisorCall,
	renderContactSupervisorResult,
	renderIntercomCall,
	renderIntercomResult,
} from "../../packages/intercom/result-renderers.js";
import {
	renderSubagentToolCall,
	renderSubagentToolResult,
} from "../../packages/subagents/src/extension/tool-rendering.js";
import { bindSubagentChildCards } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	SUBAGENT_CHILD_RECORD_TYPE,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { taskToolResult } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { Details } from "../../packages/subagents/src/shared/types.js";
import { renderSingleCompact } from "../../packages/subagents/src/tui/render-result-compact.js";
import { taskRecord } from "../helpers/task-record.js";
import { theme } from "./subagents-render-stability-helpers.js";

type Result = Details["results"][number];

const originalKeybindings = getKeybindings();

beforeEach(() => {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
});

afterEach(() => setKeybindings(originalKeybindings));

function details(result: Result): Details {
	return { mode: "single", results: [result] } as Details;
}

function running(toolCount: number, recent: number): Result {
	return {
		agent: "debugger",
		task: "#5220 spawn lock\nmore detail the block never shows",
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		status: "ok",
		progress: {
			index: 0,
			agent: "debugger",
			status: "running",
			task: "#5220 spawn lock",
			recentTools: Array.from({ length: recent }, (_, i) => ({ tool: "bash", args: `step ${i + 1}`, endMs: i })),
			recentOutput: [],
			toolCount,
			tokens: 87_400,
			durationMs: 18 * 60_000,
		},
	} as unknown as Result;
}

function runningSteps(completed: number, currentArgs?: string): Result {
	const recentStart = Math.max(0, completed - 5);
	const recentCount = completed - recentStart;
	const base = running(completed + (currentArgs ? 1 : 0), 0);
	return {
		...base,
		progress: {
			...base.progress!,
			recentTools: Array.from({ length: recentCount }, (_, i) => ({
				tool: "bash",
				args: `step ${recentStart + i + 1}`,
				endMs: recentStart + i,
			})),
			...(currentArgs ? { currentTool: "bash", currentToolArgs: currentArgs, currentToolStartedAt: 0 } : {}),
		},
	};
}

const text = (component: { render(width: number): string[] }, width = 160) =>
	component
		.render(width)
		.map((line) => stripTerminalSequences(line).trimEnd())
		.join("\n");

test("a running child shows its last three tool calls and one running line under its call heading (#5224)", () => {
	const out = text(renderSingleCompact(details(running(9, 5)), running(9, 5), theme, 0));
	assert.doesNotMatch(out, /Agent\(|more detail the block never shows/);
	assert.match(out, /… \+6 tool uses/);
	assert.match(out, /step 3/);
	assert.match(out, /step 5/);
	assert.doesNotMatch(out, /step 2/);
	assert.match(out, /^ {2}⎿ {2}Running · 18m · ↓ 87\.4k tokens · ↓ to manage$/m);
});

test("a running child's line names no model and counts output even without tool calls (#5224)", () => {
	const child = { ...running(0, 0), model: "anthropic/claude-haiku", thinking: "low" } as Result;
	const out = text(renderSingleCompact(details(child), child, theme, 0));
	assert.match(out, /⎿ {2}Running · 18m · ↓ 87\.4k tokens/);
	assert.doesNotMatch(out, /claude-haiku/);
});

test("a running card keeps each tool on one line at narrow and wide widths (#5224)", () => {
	const child = running(3, 3);
	child.progress!.recentTools = child.progress!.recentTools.map((tool) => ({ ...tool, args: "x".repeat(180) }));
	for (const width of [20, 80, 160]) {
		const lines = renderSingleCompact(details(child), child, theme, 0).render(width);
		assert.equal(lines.length, 5, `three tools, activity and status at ${width} columns`);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
});

test("a running card's management hint follows rebound and disabled live keys (#5224)", () => {
	const child = running(0, 0);
	setKeybindings(new KeybindingsManager({ "app.agents.focus": "ctrl+g" }));
	assert.match(text(renderSingleCompact(details(child), child, theme, 0)), /ctrl\+g to manage/);
	setKeybindings(new KeybindingsManager({ "app.agents.focus": [], "app.tools.expand": "ctrl+e" }));
	assert.match(text(renderSingleCompact(details(child), child, theme, 0)), /ctrl\+e for live detail/);
	setKeybindings(new KeybindingsManager({ "app.agents.focus": [], "app.tools.expand": [] }));
	assert.doesNotMatch(text(renderSingleCompact(details(child), child, theme, 0)), /to manage|for live detail/);
});

test("a running child with few tool calls folds nothing (#5224)", () => {
	const out = text(renderSingleCompact(details(running(2, 2)), running(2, 2), theme, 0));
	assert.doesNotMatch(out, /tool uses?$/m);
	assert.doesNotMatch(out, /… \+/);
});

test("a finished child is one outcome line plus the result's headline (#5224)", () => {
	const result = {
		...running(4, 4),
		progress: undefined,
		progressSummary: { toolCount: 4, tokens: 12_000, durationMs: 91 * 60_000 },
		finalOutput: "PR #5221 open: atomic lock creation\nsecond line stays hidden",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "PR #5221 open: atomic lock creation\nsecond line stays hidden" }],
			},
		],
	} as unknown as Result;
	const out = text(renderSingleCompact(details(result), result, theme, 0));
	assert.match(out, /^● debugger finished · 1h 31m$/m);
	assert.doesNotMatch(out, /tool uses|tokens|⟳/);
	assert.match(out, /⎿ {2}PR #5221 open: atomic lock creation/);
	assert.doesNotMatch(out, /second line stays hidden/);
	assert.doesNotMatch(out, /session:/);
});

test("a running child keeps its completed tool beside the current tool (#5243)", () => {
	const child = runningSteps(1, "step 2");
	const out = text(renderSingleCompact(details(child), child, theme, 0));
	assert.doesNotMatch(out, /… \+/);
	assert.match(out, /bash: step 1/);
	assert.match(out, /bash: step 2/);
});

test("a running child accounts for all nine tool calls while active and settled (#5243)", () => {
	const active = runningSteps(8, "step 9");
	const activeOut = text(renderSingleCompact(details(active), active, theme, 0));
	assert.match(activeOut, /… \+6 tool uses/);
	assert.doesNotMatch(activeOut, /step 6/);
	assert.match(activeOut, /bash: step 7/);
	assert.match(activeOut, /bash: step 8/);
	assert.match(activeOut, /bash: step 9/);

	const betweenTools = runningSteps(9);
	const betweenOut = text(renderSingleCompact(details(betweenTools), betweenTools, theme, 0));
	assert.match(betweenOut, /… \+6 tool uses/);
	assert.doesNotMatch(betweenOut, /step 6/);
	assert.match(betweenOut, /bash: step 7/);
	assert.match(betweenOut, /bash: step 9/);
	assert.match(betweenOut, /thinking…/);

	const settled = {
		...betweenTools,
		progress: undefined,
		progressSummary: { toolCount: 9, tokens: 87_400, durationMs: 18 * 60_000 },
		finalOutput: "All nine steps verified\ndetails behind expand",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "All nine steps verified\ndetails behind expand" }],
			},
		],
	} as unknown as Result;
	const settledOut = text(renderSingleCompact(details(settled), settled, theme, 0));
	assert.match(settledOut, /^● debugger finished · 18m$/m);
	assert.doesNotMatch(settledOut, /tool uses/);
	assert.match(settledOut, /⎿ {2}All nine steps verified/);
	assert.doesNotMatch(settledOut, /… \+|bash: step|Running|details behind expand/);
});

test("task-backed CLI launches render canonical Agent tool blocks for running, needs input, done, failed, and stopped states (#5350)", () => {
	const rawPrompt = "#5220 spawn lock\nFull multi-line prompt instructions that must never appear in the header";
	const context = { toolCallId: "cli-agent-1", state: {}, invalidate() {} };
	const call = renderSubagentToolCall({ agent: "debugger", task: rawPrompt }, theme, context);
	assert.equal(isToolBlock(call), true);
	assert.equal(text(call, 80), " ∀ Agent(debugger · #5220 spawn lock)");

	const runningTask = {
		...taskRecord("task-run"),
		agentName: "debugger",
		title: "#5220 spawn lock",
		model: "anthropic/claude-haiku-4-5",
		thinking: "low",
		metrics: { elapsedMs: 18 * 60_000, tokenCount: 87_400, toolCount: 4 },
	};
	const runningResult = taskToolResult({
		kind: "admitted",
		observation: {
			kind: "yielded",
			taskId: "task-run" as TaskId,
			waitId: "wait-run" as WaitId,
			reason: "explicit",
		},
	});
	runningResult.details!.taskRecords = [runningTask];

	const runningBlock = renderSubagentToolResult(runningResult, { expanded: false, isPartial: false }, theme, context);
	assert.equal(isToolBlock(runningBlock), true);
	for (const width of [80, 160]) {
		const rows = runningBlock.render(width);
		assert.deepEqual(
			rows.map((r) => stripTerminalSequences(r).trimEnd()),
			[" ◯ Agent(debugger · #5220 spawn lock)", "   ⎿  Running · 18m · ↓ 87.4k tokens · ↓ to manage"],
		);
		assert.ok(rows.every((r) => visibleWidth(r) <= width));
		assert.ok(!rows.join("").includes("\u001b[48;"));
	}
	assert.doesNotMatch(text(runningBlock, 160), /claude-haiku|\/tasks|\[fork\]|active now/);

	setKeybindings(new KeybindingsManager({ "app.agents.focus": "ctrl+g" }));
	assert.match(
		text(renderSubagentToolResult(runningResult, { expanded: false, isPartial: false }, theme, context)),
		/ctrl\+g to manage/,
	);
	setKeybindings(new KeybindingsManager({ "app.agents.focus": [] }));
	assert.doesNotMatch(
		text(renderSubagentToolResult(runningResult, { expanded: false, isPartial: false }, theme, context)),
		/to manage/,
	);
	setKeybindings(new KeybindingsManager());

	const nonPanelTask = { ...runningTask, observation: { kind: "none" as const, reason: "task-settled" as const } };
	const nonPanelResult = { ...runningResult, details: { ...runningResult.details!, taskRecords: [nonPanelTask] } };
	assert.equal(
		text(renderSubagentToolResult(nonPanelResult, { expanded: false, isPartial: false }, theme, context)).split(
			"\n",
		)[1],
		"   ⎿  Running · 18m · ↓ 87.4k tokens",
	);

	const inputTask = {
		...runningTask,
		attention: {
			kind: "input-needed" as const,
			prompt: "Approve lock strategy?\nAdditional context",
			requestId: "p-1",
			route: { sessionId: "child-session", promptId: "p-1" },
		},
	};
	const inputResult = { ...runningResult, details: { ...runningResult.details!, taskRecords: [inputTask] } };
	assert.deepEqual(
		text(renderSubagentToolResult(inputResult, { expanded: false, isPartial: false }, theme, context)).split("\n"),
		[" ◆ Agent(debugger · #5220 spawn lock)", "   ⎿  Needs input · Approve lock strategy? · ↓ to answer"],
	);

	const doneResult = taskToolResult({
		kind: "admitted",
		observation: {
			kind: "settled",
			taskId: "task-run" as TaskId,
			result: { kind: "completed", output: runningTask.output },
		},
	});
	doneResult.details!.taskRecords = [
		{ ...runningTask, execution: { kind: "settled", result: { kind: "completed", output: runningTask.output } } },
	];
	assert.deepEqual(
		text(renderSubagentToolResult(doneResult, { expanded: false, isPartial: false }, theme, context)).split("\n"),
		[" ● Agent(debugger · #5220 spawn lock)", "   ⎿  Done · 18m · ↓ 87.4k tokens"],
	);

	const failedResult = taskToolResult({
		kind: "admitted",
		observation: {
			kind: "settled",
			taskId: "task-run" as TaskId,
			result: { kind: "failed", code: "AgentFailed", message: "Lock check failed\ndetails" },
		},
	});
	failedResult.details!.taskRecords = [
		{
			...runningTask,
			metrics: { elapsedMs: 120_000 },
			execution: { kind: "settled", result: { kind: "failed", code: "AgentFailed", message: "Lock check failed" } },
		},
	];
	assert.deepEqual(
		text(renderSubagentToolResult(failedResult, { expanded: false, isPartial: false }, theme, context)).split("\n"),
		[" ✗ Agent(debugger · #5220 spawn lock)", "   ⎿  Failed · 2m · Lock check failed"],
	);

	const stoppedResult = taskToolResult({
		kind: "admitted",
		observation: {
			kind: "settled",
			taskId: "task-run" as TaskId,
			result: { kind: "cancelled", cause: "user" },
		},
	});
	stoppedResult.details!.taskRecords = [
		{
			...runningTask,
			metrics: { elapsedMs: 12_000 },
			execution: { kind: "settled", result: { kind: "cancelled", cause: "user" } },
		},
	];
	assert.deepEqual(
		text(renderSubagentToolResult(stoppedResult, { expanded: false, isPartial: false }, theme, context)).split("\n"),
		[" ◯ Agent(debugger · #5220 spawn lock)", "   ⎿  Stopped · 12s"],
	);

	for (const width of [12, 20, 80, 160]) {
		for (const candidate of [runningResult, inputResult, doneResult, failedResult, stoppedResult]) {
			const rendered = renderSubagentToolResult(
				candidate,
				{ expanded: false, isPartial: false },
				theme,
				context,
			).render(width);
			assert.ok(
				rendered.every((line) => visibleWidth(line) <= width),
				`fits width ${width}`,
			);
		}
	}
});

test("parallel task-backed launches render one canonical ToolBlock per child without fork or model clutter (#5350)", () => {
	const context = { toolCallId: "cli-parallel-1", state: {}, invalidate() {} };
	const call = renderSubagentToolCall(
		{
			context: "fork",
			tasks: [
				{ agent: "debugger", task: "#5220 spawn lock\ndetails" },
				{ agent: "worker", task: "Fix shipping batches. Second sentence ignored in short title." },
			],
		},
		theme,
		context,
	);
	assert.equal(isToolBlock(call), true);
	const response: ModelParallelResponse = {
		kind: "parallel",
		slots: [
			{
				ordinal: 0,
				outcome: {
					kind: "admitted",
					observation: {
						kind: "yielded",
						taskId: "task-p1" as TaskId,
						waitId: "wait-p1" as WaitId,
						reason: "explicit",
					},
				},
			},
			{
				ordinal: 1,
				outcome: {
					kind: "admitted",
					observation: {
						kind: "settled",
						taskId: "task-p2" as TaskId,
						result: { kind: "failed", code: "Probe", message: "Batch check failed" },
					},
				},
			},
		],
	};
	const result = {
		content: [{ type: "text" as const, text: JSON.stringify(response) }],
		details: {
			mode: "parallel" as const,
			context: "fork" as const,
			results: [],
			taskResponse: response,
			taskRecords: [
				{
					...taskRecord("task-p1"),
					agentName: "debugger",
					title: "#5220 spawn lock",
					metrics: { elapsedMs: 60_000, tokenCount: 12_000 },
				},
				{
					...taskRecord("task-p2"),
					agentName: "worker",
					title: "Fix shipping batches. Second sentence ignored in short title.",
					metrics: { elapsedMs: 15_000 },
					execution: {
						kind: "settled" as const,
						result: { kind: "failed" as const, code: "Probe", message: "Batch check failed" },
					},
				},
			],
		},
	};
	const group = renderSubagentToolResult(result, { expanded: false, isPartial: false }, theme, context);
	assert.equal(isToolBlock(group), true);
	assert.deepEqual(text(group, 100).split("\n"), [
		" ◯ Agent(debugger · #5220 spawn lock)",
		"   ⎿  Running · 1m · ↓ 12.0k tokens · ↓ to manage",
		"",
		" ✗ Agent(worker · Fix shipping batches.)",
		"   ⎿  Failed · 15s · Batch check failed",
	]);
});

test("expanded Agent block renders Prompt, Tool calls as indented ToolBlocks without inherited fork history, and Result (#5350)", async () => {
	const store = new MemorySessionStore();
	const parentSession = await SessionManager.create(store, process.cwd());
	const childSession = await SessionManager.create(store, process.cwd());
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	await childSession.appendMessage({
		role: "user",
		content: "Inherited parent prompt that must not appear",
		timestamp: 1,
	});
	await childSession.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "inherited-call", name: "edit", arguments: { path: "inherited.ts" } }],
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: 2,
	});
	const launchLeafId = childSession.getLeafId();
	await childSession.appendMessage({
		role: "user",
		content: "Inspect **greet.ts** and run checks",
		timestamp: 3,
	});
	await childSession.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "child-read-1", name: "read", arguments: { path: "src/greet.ts" } }],
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: 4,
	});
	await childSession.appendMessage({
		role: "toolResult",
		toolCallId: "child-read-1",
		toolName: "read",
		content: [{ type: "text", text: "export const greet = () => 'hi';\n" }],
		isError: false,
		timestamp: 5,
	});
	await childSession.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Verified **greet.ts** exports `greet`." }],
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "stop",
		timestamp: 6,
	});

	const record: SubagentChildRecord = {
		version: 1,
		childId: "exp-run:0",
		runId: "exp-run",
		index: 0,
		agent: "debugger",
		forked: true,
		state: "terminal",
		terminalStatus: "ok",
		cwd: process.cwd(),
		owner: { kind: "session", sessionId: parentSession.getSessionId() },
		taskId: "task-exp-1",
		childSessionId: childSession.getSessionId(),
		launchLeafId,
		task: "Inspect **greet.ts** and run checks",
	};
	await parentSession.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, record);
	bindSubagentChildCards({ sessionManager: parentSession });

	let invalidated = false;
	const context = {
		toolCallId: "exp-call",
		state: {},
		invalidate() {
			invalidated = true;
		},
	};
	renderSubagentToolCall({ agent: "debugger", task: "Inspect **greet.ts** and run checks" }, theme, context);
	const response = taskToolResult({
		kind: "admitted",
		observation: {
			kind: "settled",
			taskId: "task-exp-1" as TaskId,
			result: { kind: "completed", output: taskRecord("task-exp-1").output },
		},
	});
	response.details!.ownerSessionId = parentSession.getSessionId();

	renderSubagentToolResult(response, { expanded: true, isPartial: false }, theme, context).render(100);
	for (let attempt = 0; attempt < 50 && !invalidated; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	const expanded = text(renderSubagentToolResult(response, { expanded: true, isPartial: false }, theme, context), 100);
	assert.match(expanded, /⎿ {2}Prompt/);
	assert.match(expanded, /Inspect greet\.ts and run checks/);
	assert.match(expanded, /⎿ {2}Tool calls/);
	assert.match(expanded, /^ {6}● Read\(src\/greet\.ts\)$/m);
	assert.match(expanded, /⎿ {2}Result/);
	assert.match(expanded, /Verified greet\.ts exports/);
	assert.doesNotMatch(expanded, /Inherited parent prompt|inherited\.ts/);
	await store.close();
});

test("task-backed launch block dynamically refreshes elapsed time, fresh task tokens, and needs-input/settled transitions via getTaskRecord (#5350)", () => {
	const initialTask = {
		...taskRecord("task-live-1"),
		agentName: "debugger",
		title: "#5220 spawn lock",
		metrics: { elapsedMs: 2_000, tokenCount: 1_200, toolCount: 1 },
	};
	let liveTask = initialTask;
	let mockNow = 10_000;
	const realNow = Date.now;
	Date.now = () => mockNow;
	try {
		const context = {
			toolCallId: "cli-live-1",
			state: {},
			invalidate() {},
			getTaskRecord: (taskId: string) => (taskId === "task-live-1" ? liveTask : undefined),
		};
		renderSubagentToolCall({ agent: "debugger", task: "#5220 spawn lock" }, theme, context);
		const runningResult = taskToolResult({
			kind: "admitted",
			observation: {
				kind: "yielded",
				taskId: "task-live-1" as TaskId,
				waitId: "wait-live-1" as WaitId,
				reason: "explicit",
			},
		});
		runningResult.details!.taskRecords = [initialTask];

		const block = renderSubagentToolResult(runningResult, { expanded: false, isPartial: false }, theme, context) as {
			render(width: number): string[];
			invalidate(): void;
			isWorking?: () => boolean;
		};
		assert.equal(isToolBlock(block), true);
		assert.equal(block.isWorking?.(), true);
		assert.deepEqual(text(block, 80).split("\n"), [
			" ◯ Agent(debugger · #5220 spawn lock)",
			"   ⎿  Running · 2s · ↓ 1.2k tokens · ↓ to manage",
		]);

		mockNow = 15_000;
		assert.deepEqual(text(block, 80).split("\n"), [
			" ◯ Agent(debugger · #5220 spawn lock)",
			"   ⎿  Running · 7s · ↓ 1.2k tokens · ↓ to manage",
		]);

		mockNow = 20_000;
		liveTask = { ...initialTask, metrics: { elapsedMs: 12_000, tokenCount: 45_600, toolCount: 3 } };
		assert.deepEqual(text(block, 80).split("\n"), [
			" ◯ Agent(debugger · #5220 spawn lock)",
			"   ⎿  Running · 12s · ↓ 45.6k tokens · ↓ to manage",
		]);

		liveTask = {
			...liveTask,
			attention: {
				kind: "input-needed" as const,
				prompt: "Approve deployment?",
				requestId: "q-live",
				route: { sessionId: "child-session", promptId: "q-live" },
			},
		};
		assert.deepEqual(text(block, 80).split("\n"), [
			" ◆ Agent(debugger · #5220 spawn lock)",
			"   ⎿  Needs input · Approve deployment? · ↓ to answer",
		]);

		liveTask = {
			...initialTask,
			metrics: { elapsedMs: 25_000, tokenCount: 50_000, toolCount: 4 },
			execution: { kind: "settled" as const, result: { kind: "completed" as const, output: initialTask.output } },
		};
		assert.deepEqual(text(block, 80).split("\n"), [
			" ● Agent(debugger · #5220 spawn lock)",
			"   ⎿  Done · 25s · ↓ 50.0k tokens",
		]);
		assert.equal(block.isWorking?.(), false);
	} finally {
		Date.now = realNow;
	}
});

test("Agent block header prefers TaskRecord.title over raw identity.task while expanded Prompt retains full prompt (#5350)", () => {
	const rawPrompt = "Investigate the failing CI step in detail.\nThen write a regression test.";
	const context = { toolCallId: "cli-title-pref", state: {}, invalidate() {} };
	renderSubagentToolCall({ agent: "debugger", task: rawPrompt }, theme, context);
	const result = taskToolResult({
		kind: "admitted",
		observation: {
			kind: "settled",
			taskId: "task-title-pref" as TaskId,
			result: { kind: "completed", output: taskRecord("task-title-pref").output },
		},
	});
	result.details!.taskRecords = [
		{
			...taskRecord("task-title-pref"),
			agentName: "debugger",
			title: "#5220 spawn lock",
			metrics: { elapsedMs: 10_000, tokenCount: 4_000 },
			execution: { kind: "settled", result: { kind: "completed", output: taskRecord("task-title-pref").output } },
		},
	];
	const collapsed = text(renderSubagentToolResult(result, { expanded: false, isPartial: false }, theme, context), 100);
	assert.deepEqual(collapsed.split("\n"), [
		" ● Agent(debugger · #5220 spawn lock)",
		"   ⎿  Done · 10s · ↓ 4.0k tokens",
	]);
	const expanded = text(renderSubagentToolResult(result, { expanded: true, isPartial: false }, theme, context), 100);
	assert.equal(expanded.split("\n")[0], " ● Agent(debugger · #5220 spawn lock)");
	assert.match(expanded, /⎿ {2}Prompt[\s\S]*Investigate the failing CI step in detail\./);
});

test("expanded Agent block releases cached transcript on collapse and fails closed when fork anchor is missing (#5350)", async () => {
	const store = new MemorySessionStore();
	const parentSession = await SessionManager.create(store, process.cwd());
	const childSession = await SessionManager.create(store, process.cwd());
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	await childSession.appendMessage({ role: "user", content: "Check parser", timestamp: 1 });
	await childSession.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Parser ok" }],
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "stop",
		timestamp: 2,
	});
	const record: SubagentChildRecord = {
		version: 1,
		childId: "cache-rel:0",
		runId: "cache-rel",
		index: 0,
		agent: "debugger",
		state: "terminal",
		terminalStatus: "ok",
		cwd: process.cwd(),
		owner: { kind: "session", sessionId: parentSession.getSessionId() },
		taskId: "task-cache-rel",
		childSessionId: childSession.getSessionId(),
		launchLeafId: null,
		task: "Check parser",
	};
	await parentSession.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, record);
	bindSubagentChildCards({ sessionManager: parentSession });

	let childLoads = 0;
	// A card reads a saved child's rows, starting with which rows its launch shows, instead of reopening the child.
	const readChildDisplayCut = store.readChildDisplayCut.bind(store);
	let countRead = (sessionId: string) => {
		if (sessionId === childSession.getSessionId()) childLoads += 1;
	};
	store.readChildDisplayCut = (sessionId, launch) => {
		countRead(sessionId);
		return readChildDisplayCut(sessionId, launch);
	};

	try {
		let invalidated = 0;
		const context = {
			toolCallId: "cache-rel-call",
			state: {},
			invalidate() {
				invalidated += 1;
			},
		};
		renderSubagentToolCall({ agent: "debugger", task: "Check parser" }, theme, context);
		const response = taskToolResult({
			kind: "admitted",
			observation: {
				kind: "settled",
				taskId: "task-cache-rel" as TaskId,
				result: { kind: "completed", output: taskRecord("task-cache-rel").output },
			},
		});
		response.details!.ownerSessionId = parentSession.getSessionId();

		renderSubagentToolResult(response, { expanded: false, isPartial: false }, theme, context).render(100);
		assert.equal(childLoads, 0, "collapsed render never loads child session");

		const expandedBlock = renderSubagentToolResult(response, { expanded: true, isPartial: false }, theme, context);
		expandedBlock.render(100);
		for (let i = 0; i < 30 && invalidated === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(childLoads, 1);
		expandedBlock.render(100);
		expandedBlock.render(80);
		assert.equal(childLoads, 1, "repeated renders while expanded reuse cached transcript");

		renderSubagentToolResult(response, { expanded: false, isPartial: false }, theme, context).render(100);
		const reExpanded = renderSubagentToolResult(response, { expanded: true, isPartial: false }, theme, context);
		reExpanded.render(100);
		for (let i = 0; i < 30 && childLoads < 2; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(childLoads, 2, "collapsing clears cached transcript so re-expanding loads afresh");

		const forkedChild = await SessionManager.create(store, process.cwd());
		await forkedChild.appendMessage({ role: "user", content: "Parent secret prompt", timestamp: 1 });
		await forkedChild.appendMessage({
			role: "assistant",
			content: [
				{ type: "toolCall", id: "parent-secret-tool", name: "bash", arguments: { command: "cat /etc/shadow" } },
			],
			api: "test",
			provider: "test",
			model: "test",
			usage,
			stopReason: "toolUse",
			timestamp: 2,
		});
		const brokenForkRecord: SubagentChildRecord = {
			version: 1,
			childId: "broken-fork:0",
			runId: "broken-fork",
			index: 0,
			agent: "debugger",
			forked: true,
			state: "terminal",
			terminalStatus: "ok",
			cwd: process.cwd(),
			owner: { kind: "session", sessionId: parentSession.getSessionId() },
			taskId: "task-broken-fork",
			childSessionId: forkedChild.getSessionId(),
			launchLeafId: "nonexistent-anchor-id",
			task: "Child own task",
		};
		await parentSession.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, brokenForkRecord);
		bindSubagentChildCards({ sessionManager: parentSession });

		let forkLoads = 0;
		countRead = (sessionId) => {
			if (sessionId === forkedChild.getSessionId()) forkLoads += 1;
		};
		const forkContext = { toolCallId: "broken-fork-call", state: {}, invalidate() {} };
		renderSubagentToolCall({ agent: "debugger", task: "Child own task" }, theme, forkContext);
		const forkResponse = taskToolResult({
			kind: "admitted",
			observation: {
				kind: "settled",
				taskId: "task-broken-fork" as TaskId,
				result: { kind: "completed", output: taskRecord("task-broken-fork").output },
			},
		});
		forkResponse.details!.ownerSessionId = parentSession.getSessionId();
		renderSubagentToolResult(forkResponse, { expanded: true, isPartial: false }, theme, forkContext).render(100);
		for (let i = 0; i < 30 && forkLoads === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
		const forkOut = text(
			renderSubagentToolResult(forkResponse, { expanded: true, isPartial: false }, theme, forkContext),
			100,
		);
		assert.doesNotMatch(forkOut, /Parent secret prompt|shadow/);
		assert.match(forkOut, /Child own task/);

		const missingFileRecord: SubagentChildRecord = {
			version: 1,
			childId: "missing-file:0",
			runId: "missing-file",
			index: 0,
			agent: "debugger",
			state: "terminal",
			terminalStatus: "ok",
			cwd: process.cwd(),
			owner: { kind: "session", sessionId: parentSession.getSessionId() },
			taskId: "task-missing-file",
			childSessionFile: "/nonexistent/missing-child-session.jsonl",
			task: "Audit missing session file",
		};
		await parentSession.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, missingFileRecord);
		bindSubagentChildCards({ sessionManager: parentSession });
		let missingInvalidated = false;
		const missingContext = {
			toolCallId: "missing-file-call",
			state: {},
			invalidate() {
				missingInvalidated = true;
			},
		};
		renderSubagentToolCall({ agent: "debugger", task: "Audit missing session file" }, theme, missingContext);
		const missingResponse = taskToolResult({
			kind: "admitted",
			observation: {
				kind: "settled",
				taskId: "task-missing-file" as TaskId,
				result: { kind: "completed", output: taskRecord("task-missing-file").output },
			},
		});
		missingResponse.details!.ownerSessionId = parentSession.getSessionId();
		missingResponse.details!.taskRecords = [
			{
				...taskRecord("task-missing-file"),
				agentName: "debugger",
				title: "Audit missing session file",
				metrics: { elapsedMs: 5_000, toolCount: 3 },
				execution: {
					kind: "settled",
					result: { kind: "completed", output: taskRecord("task-missing-file").output },
				},
			},
		];
		renderSubagentToolResult(missingResponse, { expanded: true, isPartial: false }, theme, missingContext).render(
			100,
		);
		for (let i = 0; i < 20 && !missingInvalidated; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const missingOut = text(
			renderSubagentToolResult(missingResponse, { expanded: true, isPartial: false }, theme, missingContext),
			100,
		);
		assert.match(missingOut, /⎿ {2}Tool calls[\s\S]*Transcript unavailable/);
		assert.doesNotMatch(missingOut, /Tool calls\n {6}\(none\)/);

		const extChild = await SessionManager.create(store, process.cwd());
		await extChild.appendMessage({ role: "user", content: "Coordinate with supervisor", timestamp: 1 });
		await extChild.appendMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "ic-1",
					name: "intercom",
					arguments: { action: "ask", to: "worker-2", message: "ready?" },
				},
				{
					type: "toolCall",
					id: "sup-1",
					name: "contact_supervisor",
					arguments: { reason: "need_decision", message: "Approve API?" },
				},
				{
					type: "toolCall",
					id: "priv-1",
					name: "private_tool",
					arguments: { secretToken: "top-secret-token-123" },
				},
			],
			api: "test",
			provider: "test",
			model: "test",
			usage,
			stopReason: "toolUse",
			timestamp: 2,
		});
		await extChild.appendMessage({
			role: "toolResult",
			toolCallId: "ic-1",
			toolName: "intercom",
			content: [
				{
					type: "text",
					text: 'Ask 99999999-1234-1234-1234-123456789abc delivered to worker-2 (busy). Cancel with intercom({ action: "cancel", askId: "99999999-1234-1234-1234-123456789abc" }).',
				},
			],
			details: { action: "ask", to: "worker-2", pending: true, askId: "99999999-1234-1234-1234-123456789abc" },
			isError: false,
			timestamp: 3,
		});
		await extChild.appendMessage({
			role: "toolResult",
			toolCallId: "sup-1",
			toolName: "contact_supervisor",
			content: [{ type: "text", text: "Delivered to supervisor." }],
			details: { reason: "need_decision", delivered: true },
			isError: false,
			timestamp: 4,
		});
		await extChild.appendMessage({
			role: "toolResult",
			toolCallId: "priv-1",
			toolName: "private_tool",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 5,
		});
		const extRecord: SubagentChildRecord = {
			version: 1,
			childId: "ext-tools:0",
			runId: "ext-tools",
			index: 0,
			agent: "debugger",
			state: "terminal",
			terminalStatus: "ok",
			cwd: process.cwd(),
			owner: { kind: "session", sessionId: parentSession.getSessionId() },
			taskId: "task-ext-tools",
			childSessionId: extChild.getSessionId(),
			launchLeafId: null,
			task: "Coordinate with supervisor",
		};
		await parentSession.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, extRecord);
		bindSubagentChildCards({ sessionManager: parentSession });
		let extInvalidated = false;
		const extContext = {
			toolCallId: "ext-tools-call",
			state: {},
			invalidate() {
				extInvalidated = true;
			},
			getToolDefinition: (name: string) => {
				if (name === "intercom") return { renderCall: renderIntercomCall, renderResult: renderIntercomResult };
				if (name === "contact_supervisor")
					return { renderCall: renderContactSupervisorCall, renderResult: renderContactSupervisorResult };
				if (name === "private_tool")
					return {
						renderCall: () => new Text("PrivateTool(redacted)", 0, 0),
						renderResult: () => new Text("OK", 0, 0),
					};
				return undefined;
			},
		};
		renderSubagentToolCall({ agent: "debugger", task: "Coordinate with supervisor" }, theme, extContext);
		const extResponse = taskToolResult({
			kind: "admitted",
			observation: {
				kind: "settled",
				taskId: "task-ext-tools" as TaskId,
				result: { kind: "completed", output: taskRecord("task-ext-tools").output },
			},
		});
		extResponse.details!.ownerSessionId = parentSession.getSessionId();
		renderSubagentToolResult(extResponse, { expanded: true, isPartial: false }, theme, extContext).render(100);
		for (let i = 0; i < 30 && !extInvalidated; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const extOut = text(
			renderSubagentToolResult(extResponse, { expanded: true, isPartial: false }, theme, extContext),
			100,
		);
		assert.match(extOut, /● Intercom\(ask → worker-2\)/);
		assert.match(extOut, /⎿ {2}Asked · reply will arrive as a message/);
		assert.doesNotMatch(extOut, /99999999-1234|action: "cancel"/);
		assert.match(extOut, /● Supervisor\(need decision\)/);
		assert.match(extOut, /● PrivateTool\(redacted\)/);
		assert.doesNotMatch(extOut, /top-secret-token-123/);
	} finally {
		store.readChildDisplayCut = readChildDisplayCut;
		await store.close();
	}
});
