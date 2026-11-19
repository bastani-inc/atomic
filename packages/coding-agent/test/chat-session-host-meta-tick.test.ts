import assert from "node:assert/strict";
import { stripHintMarkers } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ChatSessionHost } from "../src/modes/interactive/components/chat-session-host.ts";
import type { ChatSessionHostOpts } from "../src/modes/interactive/components/chat-session-host-types.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function options(requestRender: () => void): ChatSessionHostOpts {
	return {
		style: {
			dim: String,
			text: String,
			textMuted: String,
			accent: String,
			accentBold: String,
			rule: (_hex, text) => text,
			cursor: () => "",
			blank: (width) => " ".repeat(width),
			editorRuleColor: () => "#ffffff",
		},
		editorTheme: {
			borderColor: String,
			selectList: {
				selectedPrefix: String,
				selectedText: String,
				description: String,
				scrollInfo: String,
				noMatch: String,
			},
		},
		requestRender,
	};
}

beforeEach(() => {
	initTheme("dark");
	vi.useFakeTimers();
	vi.setSystemTime(0);
	vi.stubEnv("ATOMIC_REDUCED_MOTION", "1");
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

test("reduced-motion compaction repaints once a second and stops after completion (#5243)", () => {
	let renders = 0;
	const host = new ChatSessionHost(options(() => renders++));
	try {
		host.applyAgentEvent({ type: "compaction_start", reason: "manual" });
		vi.advanceTimersByTime(100);
		const before = renders;
		assert.equal(host.hasAnimationTick(), false);
		vi.advanceTimersByTime(2_900);
		assert.equal(renders - before, 3);
		assert.match(host.renderWorkingStatus(80).map(stripHintMarkers).join("\n"), /3s · esc to cancel/);
		host.applyAgentEvent({
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted: false,
			willRetry: false,
		});
		vi.advanceTimersByTime(100);
		const ended = renders;
		vi.advanceTimersByTime(3_000);
		assert.equal(renders, ended);
	} finally {
		host.dispose();
	}
});

test("reduced-motion working clocks repaint through a silent tool and stop on dispose (#5243)", () => {
	let renders = 0;
	const host = new ChatSessionHost(options(() => renders++));
	try {
		host.applyAgentEvent({ type: "agent_start" });
		host.applyAgentEvent({ type: "turn_start" });
		host.applyAgentEvent({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {} });
		vi.advanceTimersByTime(100);
		const before = renders;
		vi.advanceTimersByTime(2_900);
		assert.equal(renders - before, 3);
		assert.equal(host.hasAnimationTick(), false);
		assert.match(host.renderWorkingStatus(80).map(stripHintMarkers).join("\n"), /3s/);
		host.applyAgentEvent({ type: "agent_end", messages: [] });
		vi.advanceTimersByTime(100);
		const ended = renders;
		vi.advanceTimersByTime(3_000);
		assert.equal(renders, ended);
		host.beginExternalPromptLifecycle();
		vi.advanceTimersByTime(1_000);
		assert.equal(renders, ended + 2);
		host.dispose();
		const disposed = renders;
		vi.advanceTimersByTime(3_000);
		assert.equal(renders, disposed);
		assert.equal(vi.getTimerCount(), 0);
	} finally {
		host.dispose();
	}
});
