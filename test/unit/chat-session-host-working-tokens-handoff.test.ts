import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import {
	installLifecycleFakeClock,
	makeLifecycleHost,
	workingLine,
} from "./chat-session-host-working-lifecycle-fixture.ts";

/**
 * A subagent's working line counts its run's tokens from two sources: the total its task has counted, and the answer
 * streaming now. When the answer settles, the streaming part goes to 0 before the counted total includes it, so for a
 * moment the line showed fewer tokens than it just did. The count shown never goes back while the counted total is
 * unchanged; when the counted total itself goes down (a compaction), the line follows it.
 */

beforeAll(() => {
	initTheme("dark", false);
});

const tokens = (host: Parameters<typeof workingLine>[0]) => /([\d.]+k?) tokens/.exec(workingLine(host) ?? "")?.[1];

test("a subagent's working line never shows fewer tokens while an answer settles into its counted total", () => {
	const previousRandom = Math.random;
	const timers = installLifecycleFakeClock();
	Math.random = () => 0;
	let counted = 2_400;
	const host = makeLifecycleHost({ isStreaming: () => true, workingTokenCount: () => counted });
	try {
		host.applyAgentEvent({ type: "agent_start" } as never);
		host.applyAgentEvent({ type: "turn_start" } as never);
		host.applyAgentEvent({ type: "message_start", message: { role: "assistant", content: [] } } as never);
		host.applyAgentEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a".repeat(1_600) },
		} as never);
		assert.equal(tokens(host), "2.8k", "the counted total plus the answer streaming now");

		host.applyAgentEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "a".repeat(1_600) }],
				usage: { input: 2_400, output: 400, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
			},
		} as never);
		assert.equal(tokens(host), "2.8k", "the settled answer still counts before its task counts it");
		host.applyAgentEvent({ type: "turn_end" } as never);
		host.applyAgentEvent({ type: "turn_start" } as never);
		assert.equal(tokens(host), "2.8k", "the next turn starts from the same count");

		counted = 2_800;
		host.applyAgentEvent({ type: "message_start", message: { role: "assistant", content: [] } } as never);
		assert.equal(tokens(host), "2.8k", "the task counted the answer: nothing is counted twice");

		counted = 1_200;
		host.applyAgentEvent({ type: "compaction_start", reason: "threshold" } as never);
		host.applyAgentEvent({ type: "compaction_end", reason: "threshold", midTurn: true, aborted: false } as never);
		assert.equal(tokens(host), "1.2k", "a smaller counted total after a compaction is shown as it is");
	} finally {
		host.dispose();
		timers.restore();
		Math.random = previousRandom;
	}
});
