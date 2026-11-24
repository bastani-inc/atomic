import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult } from "@bastani/atomic-agent-core";
import { afterEach, beforeAll, describe, test, vi } from "vitest";
import {
	ATOMIC_WORKING_FRAME_MS,
	resetAtomicWorkingClock,
	watchAtomicWorkingClock,
} from "../../packages/coding-agent/src/modes/interactive/components/atomic-working-status.ts";
import { ToolBlock } from "../../packages/coding-agent/src/modes/interactive/components/tool-block.ts";
import { initTheme, setTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { BackgroundRenderLane } from "../../packages/coding-agent/src/modes/interactive-engine/background-render-lane.ts";
import { renderSubagentToolResult } from "../../packages/subagents/src/extension/tool-rendering.ts";
import { clearSubagentChildTranscriptCache } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.ts";
import type { Details } from "../../packages/subagents/src/shared/types.ts";

beforeAll(() => {
	initTheme("dark", false);
});

afterEach(() => {
	resetAtomicWorkingClock();
	setTheme("dark", false);
	delete process.env.NO_COLOR;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function makeBashOutput(callNumber: number): string {
	const lines: string[] = [];
	for (let i = 1; i <= 40; i++) {
		lines.push(`repro call ${callNumber} line ${i} ${"x".repeat(180)}`);
	}
	return lines.join("\n");
}

function makeForegroundResult(completedCount: number, includeRunningTail: boolean): AgentToolResult<Details> {
	const messages: Array<Record<string, unknown>> = [];
	for (let i = 1; i <= completedCount; i++) {
		const id = `call_${i}`;
		messages.push({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id,
					name: "bash",
					arguments: { command: `echo repro ${i}` },
				},
			],
		});
		messages.push({
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: makeBashOutput(i) }],
			isError: false,
		});
	}
	if (includeRunningTail) {
		messages.push({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_running",
					name: "bash",
					arguments: { command: "sleep 1800" },
				},
			],
		});
	}
	return {
		content: [{ type: "text", text: "" }],
		details: {
			mode: "single",
			results: [
				{
					agent: "debugger",
					task: "Execute 100 bash calls and keep the last one running",
					exitCode: 0,
					messages: messages as never,
					progress: {
						index: 0,
						agent: "debugger",
						task: "Execute 100 bash calls and keep the last one running",
						status: "running",
						currentTool: includeRunningTail ? "bash" : undefined,
						currentToolArgs: includeRunningTail ? "sleep 1800" : undefined,
						recentTools: [],
						recentOutput: [],
						toolCount: completedCount + (includeRunningTail ? 1 : 0),
						tokens: 12_345,
						durationMs: 42_000,
						startedAt: Date.now() - 42_000,
					},
				} as never,
			],
		} as Details,
	};
}

describe("expanded running subagent card memoization and lane pacing (#6528)", () => {
	test("expanded running subagent card does not re-render static nested tool calls on animation ticks (#6528)", () => {
		const completedCount = 90;
		const result = makeForegroundResult(completedCount, true);
		const component = renderSubagentToolResult(result, { expanded: true, isPartial: true }, theme, {
			toolCallId: "subagent_call_1",
			invalidate: () => {},
			state: {},
			outputPad: 1,
		} as never);

		const renderSpy = vi.spyOn(ToolBlock.prototype, "render");
		const firstLines = component.render(120);
		assert.ok(firstLines.length > completedCount * 2, "expanded card renders all nested tool calls");
		const initialBlockRenders = renderSpy.mock.calls.length;
		assert.ok(
			initialBlockRenders >= completedCount + 2,
			`initial render should draw outer + ${completedCount} completed + 1 running block, saw ${initialBlockRenders}`,
		);

		renderSpy.mockClear();
		for (let tick = 0; tick < 10; tick++) {
			const nextLines = component.render(120);
			assert.equal(nextLines.length, firstLines.length);
		}
		const tickBlockRenders = renderSpy.mock.calls.length;
		// Each tick should only render the outer ToolBlock + the 1 running nested ToolBlock (2 per tick = 20 total),
		// never the 90 completed nested ToolBlocks (which would be 920+).
		assert.equal(
			tickBlockRenders,
			20,
			`expected only outer + running nested ToolBlock to render on 10 ticks (20 calls), saw ${tickBlockRenders}`,
		);

		// Width change must invalidate memoized static blocks and re-render them.
		renderSpy.mockClear();
		const narrowLines = component.render(80);
		assert.ok(narrowLines.length > 0);
		assert.ok(
			renderSpy.mock.calls.length >= completedCount + 2,
			`width change should re-render all nested blocks, saw ${renderSpy.mock.calls.length}`,
		);

		// Theme change must invalidate memoized static blocks and re-render them.
		renderSpy.mockClear();
		setTheme("light", false);
		const lightLines = component.render(80);
		assert.ok(lightLines.length > 0);
		assert.ok(
			renderSpy.mock.calls.length >= completedCount + 2,
			`theme change should re-render all nested blocks, saw ${renderSpy.mock.calls.length}`,
		);

		// NO_COLOR toggle must invalidate memoized static blocks.
		renderSpy.mockClear();
		process.env.NO_COLOR = "1";
		const plainLines = component.render(80);
		assert.ok(plainLines.every((line) => line === stripVTControlCharacters(line)));
		assert.ok(
			renderSpy.mock.calls.length >= completedCount + 2,
			`NO_COLOR toggle should re-render all nested blocks, saw ${renderSpy.mock.calls.length}`,
		);
	});

	test("expanded running subagent card with no running nested tool call skips all nested ToolBlock renders on ticks (#6528)", () => {
		const completedCount = 85;
		const result = makeForegroundResult(completedCount, false);
		const component = renderSubagentToolResult(result, { expanded: true, isPartial: true }, theme, {
			toolCallId: "subagent_call_2",
			invalidate: () => {},
			state: {},
			outputPad: 1,
		} as never);

		const renderSpy = vi.spyOn(ToolBlock.prototype, "render");
		const firstLines = component.render(120);
		assert.ok(firstLines.length > completedCount * 2);

		renderSpy.mockClear();
		for (let tick = 0; tick < 10; tick++) {
			component.render(120);
		}
		// Only the outer ToolBlock renders (1 per tick = 10 total); all 85 completed nested blocks stay memoized.
		assert.equal(renderSpy.mock.calls.length, 10);
	});

	test("BackgroundRenderLane yields a bounded cooldown after slow jobs without delaying fast jobs (#6528)", async () => {
		let clock = 0;
		const cooldowns: number[] = [];
		const yieldTurns: number[] = [];
		const lane = new BackgroundRenderLane(
			async () => {
				yieldTurns.push(clock);
			},
			{
				slowThresholdMs: 16,
				maxCooldownMs: 100,
				now: () => clock,
				waitCooldown: async (ms) => {
					cooldowns.push(ms);
					clock += ms;
				},
			},
		);

		const ran: string[] = [];
		// Fast job (5ms) followed by another job -> no cooldown.
		lane.schedule("a", () => {
			clock += 5;
			ran.push("a");
		});
		lane.schedule("b", () => {
			// Slow job (60ms) -> next job should wait 60ms cooldown.
			clock += 60;
			ran.push("b");
		});
		lane.schedule("c", () => {
			// Very slow job (250ms) -> cooldown capped at 100ms.
			clock += 250;
			ran.push("c");
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(ran, ["a", "b", "c"]);
		assert.deepEqual(cooldowns, [60]);

		// Scheduling a new job right after drain() exited must still respect the 100ms cooldown from job "c".
		lane.schedule("d", () => {
			clock += 2;
			ran.push("d");
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(ran, ["a", "b", "c", "d"]);
		assert.deepEqual(cooldowns, [60, 100]);
	});

	test("atomic working clock self-reschedules instead of bursting catch-up ticks (#6528)", () => {
		vi.useFakeTimers();
		let ticks = 0;
		const unsubscribe = watchAtomicWorkingClock(() => {
			ticks += 1;
		});
		vi.advanceTimersByTime(ATOMIC_WORKING_FRAME_MS - 1);
		assert.equal(ticks, 0);
		vi.advanceTimersByTime(1);
		assert.equal(ticks, 1);
		vi.advanceTimersByTime(ATOMIC_WORKING_FRAME_MS * 3);
		assert.equal(ticks, 4);
		unsubscribe();
		vi.advanceTimersByTime(ATOMIC_WORKING_FRAME_MS * 5);
		assert.equal(ticks, 4);
	});

	test("clearSubagentChildTranscriptCache cleans up cleanly (#6528)", () => {
		const state: Record<string, unknown> = {};
		clearSubagentChildTranscriptCache(state);
	});
});
