// @ts-nocheck

import assert from "node:assert/strict";
import { afterEach, beforeAll, test } from "vitest";
import { ChatSessionHost } from "../../packages/coding-agent/src/index.ts";
import { setThemeInstance } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { loadTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme-loading.ts";
import {
	editorTheme,
	installLifecycleFakeClock,
	plainStyle,
	workingLine,
} from "./chat-session-host-working-lifecycle-fixture.ts";

const originalReducedMotion = process.env.ATOMIC_REDUCED_MOTION;

beforeAll(() => setThemeInstance(loadTheme("dark", "truecolor")));

afterEach(() => {
	if (originalReducedMotion === undefined) delete process.env.ATOMIC_REDUCED_MOTION;
	else process.env.ATOMIC_REDUCED_MOTION = originalReducedMotion;
});

const compactionResult = {
	compactedText: "[User]: retained",
	firstKeptEntryId: "m1",
	tokensBefore: 100,
	parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "task" },
	promptVersion: 3,
	rung: "planned",
	stats: {
		linesBefore: 4,
		linesDeleted: 1,
		linesKept: 3,
		rangeCount: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		percentReduction: 50,
	},
};

function makeHost(): { host: ChatSessionHost<never>; renders: () => number } {
	let renders = 0;
	const host = new ChatSessionHost<never>({
		style: plainStyle,
		editorTheme,
		isStreaming: () => true,
		requestRender: () => {
			renders += 1;
		},
	});
	return { host, renders: () => renders };
}

function midTurnEnd(overrides: object = {}): object {
	return {
		type: "compaction_end",
		reason: "threshold",
		aborted: false,
		willRetry: false,
		midTurn: true,
		...overrides,
	};
}

test("attached chat paints post-tool compaction status from the start event, not the first tick", () => {
	delete process.env.ATOMIC_REDUCED_MOTION;
	const timers = installLifecycleFakeClock();
	const { host, renders } = makeHost();
	try {
		host.applyAgentEvent({ type: "agent_start" } as never);
		host.applyAgentEvent({ type: "turn_start" } as never);
		host.applyAgentEvent({ type: "turn_end" } as never);
		const beforeStart = renders();

		host.applyAgentEvent({ type: "compaction_start", reason: "threshold", midTurn: true } as never);

		assert.equal(renders(), beforeStart + 1, "compaction_start requests its own immediate paint");
		assert.equal(workingLine(host), " ∀ Auto-compacting... (esc Cancel)");
	} finally {
		host.dispose();
		timers.restore();
	}
});

test("attached chat keeps compaction precedence through the interposed turn_start and resumes Working", () => {
	delete process.env.ATOMIC_REDUCED_MOTION;
	const timers = installLifecycleFakeClock();
	const { host, renders } = makeHost();
	try {
		host.applyAgentEvent({ type: "agent_start" } as never);
		host.applyAgentEvent({ type: "turn_start" } as never);
		host.applyAgentEvent({ type: "turn_end" } as never);
		host.applyAgentEvent({ type: "compaction_start", reason: "threshold", midTurn: true } as never);

		host.applyAgentEvent({ type: "turn_start" } as never);
		assert.equal(workingLine(host), " ∀ Auto-compacting... (esc Cancel)");

		const beforeEnd = renders();
		host.applyAgentEvent(midTurnEnd({ result: compactionResult }) as never);

		assert.equal(renders(), beforeEnd + 1, "the resumed stream repaints without another tick or input");
		assert.match(workingLine(host) ?? "", /^ ∀ /);
		assert.doesNotMatch(workingLine(host) ?? "", /compacting/i);
		assert.equal(host.hasAnimationTick(), true, "Working keeps animating after compaction");
	} finally {
		host.dispose();
		timers.restore();
	}
});

test("attached chat resumes Working after a successful post-tool no-op compaction", () => {
	delete process.env.ATOMIC_REDUCED_MOTION;
	const timers = installLifecycleFakeClock();
	const { host } = makeHost();
	try {
		host.applyAgentEvent({ type: "agent_start" } as never);
		host.applyAgentEvent({ type: "turn_start" } as never);
		host.applyAgentEvent({ type: "turn_end" } as never);
		host.applyAgentEvent({ type: "compaction_start", reason: "threshold", midTurn: true } as never);

		// Successful no-op: core emits compaction_end before the next turn_start.
		host.applyAgentEvent(midTurnEnd({ result: undefined }) as never);

		assert.match(workingLine(host) ?? "", /^ ∀ /);
		assert.doesNotMatch(workingLine(host) ?? "", /compacting/i);
		assert.equal(host.hasAnimationTick(), true);
	} finally {
		host.dispose();
		timers.restore();
	}
});

test("attached chat stops all activity when post-tool compaction aborts or fails", () => {
	delete process.env.ATOMIC_REDUCED_MOTION;
	// The two outcomes do not carry the same status data. Core omits
	// `errorMessage` from an abort event, so the attached host clears its
	// transient status; a failure keeps the event-provided error text.
	for (const [end, expectedStatus] of [
		[midTurnEnd({ aborted: true }), ""],
		[midTurnEnd({ errorMessage: "Auto-compaction failed: provider" }), "Auto-compaction failed: provider"],
	] as const) {
		const timers = installLifecycleFakeClock();
		const { host } = makeHost();
		try {
			host.applyAgentEvent({ type: "agent_start" } as never);
			host.applyAgentEvent({ type: "turn_start" } as never);
			host.applyAgentEvent({ type: "turn_end" } as never);
			host.applyAgentEvent({ type: "compaction_start", reason: "threshold", midTurn: true } as never);
			host.applyAgentEvent({ type: "turn_start" } as never);

			host.applyAgentEvent(end as never);

			assert.equal(host.statusText(), expectedStatus);
			assert.deepEqual(host.renderWorkingStatus(64), []);
			assert.equal(host.hasAnimationTick(), false);
			assert.equal(timers.intervalCount(), 0);

			// The body viewport pads to its row budget, so an empty attached chat
			// renders blank rows rather than zero lines.
			const body = host.renderBody(64, 20).join("\n");
			assert.doesNotMatch(body, /Working\.\.\.|compacting/i);
			if (expectedStatus === "") assert.equal(body.trim(), "");
			else assert.match(body, /Auto-compaction failed: provider/);
		} finally {
			host.dispose();
			timers.restore();
		}
	}
});
