/**
 * The chat host's event-only fallback path must accept a `fresh` boundary.
 *
 * The snapshot path usually hides this: persisted messages are normally rebuilt
 * before `compaction_end` arrives. When no agent-session snapshot is available,
 * the host synthesizes the boundary from the event alone, and a hard-coded
 * `planned | extension` guard there would silently drop the fresh rung — the one
 * rung the user is supposed to see.
 */

import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Component, type EditorTheme, Text } from "@earendil-works/pi-tui";
import { beforeAll, test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import type {
	CompactionRung,
	VerbatimCompactionDetails,
	VerbatimCompactionResult,
} from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { applyChatSessionAgentEvent } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-events.js";
import { ChatSessionHostState } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-state.js";
import type {
	ChatSessionHostOpts,
	ChatSessionHostStyle,
} from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-types.js";
import { CompactionBoundaryMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/compaction-boundary-message.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

beforeAll(() => initTheme("dark"));

const identity = (text: string): string => text;

const style: ChatSessionHostStyle = {
	dim: identity,
	text: identity,
	textMuted: identity,
	accent: identity,
	accentBold: identity,
	rule: (_hex, text) => text,
	cursor: () => "",
	blank: (width) => " ".repeat(width),
	editorRuleColor: () => "#ffffff",
};

const editorTheme: EditorTheme = {
	borderColor: identity,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};

function makeState(): ChatSessionHostState {
	const opts: ChatSessionHostOpts = { style, editorTheme, isStreaming: () => false };
	// No `getAgentSession`: this is exactly the event-only fallback path.
	return new ChatSessionHostState(opts, {
		renderEntry: (): Component => new Text("", 0, 0),
		transcriptCacheKey: () => "",
	});
}

function compactionResult(
	rung: CompactionRung,
	extra: Partial<VerbatimCompactionResult> = {},
): VerbatimCompactionResult {
	return {
		compactedText: "[User]: retained\n(filtered 12 lines)",
		firstKeptEntryId: null,
		tokensBefore: 51_234,
		stats: {
			linesBefore: 20,
			linesDeleted: 12,
			linesKept: 8,
			rangeCount: 1,
			tokensBefore: 51_234,
			tokensAfter: 2_000,
			percentReduction: 96.1,
		},
		parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "focus" },
		promptVersion: 3,
		rung,
		...extra,
	};
}

function endEvent(result: VerbatimCompactionResult, errorMessage?: string): AgentSessionEvent {
	return {
		type: "compaction_end",
		reason: "overflow",
		result,
		aborted: false,
		willRetry: false,
		...(errorMessage === undefined ? {} : { errorMessage }),
	} as AgentSessionEvent;
}

function boundaryDetails(state: ChatSessionHostState): VerbatimCompactionDetails[] {
	return state.transcript
		.filter((entry) => entry.kind === "custom")
		.map((entry) => (entry as { message?: { details?: VerbatimCompactionDetails } }).message?.details)
		.filter((details): details is VerbatimCompactionDetails => details !== undefined);
}

test("an event-only fresh boundary is appended, not dropped", () => {
	const state = makeState();
	assert.equal(applyChatSessionAgentEvent(state, endEvent(compactionResult("fresh"))), true);

	const details = boundaryDetails(state);
	assert.equal(details.length, 1);
	assert.equal(details[0].rung, "fresh");
});

test("the appended fresh boundary renders the degraded notice", () => {
	const state = makeState();
	applyChatSessionAgentEvent(state, endEvent(compactionResult("fresh")));
	const details = boundaryDetails(state)[0];

	const rendered = stripVTControlCharacters(
		new CompactionBoundaryMessageComponent({
			text: "[User]: retained\n(filtered 12 lines)",
			stats: details.stats,
			rung: details.rung,
		})
			.render(200)
			.join("\n"),
	);
	assert.ok(rendered.includes("✻ Context cleared (compaction degraded)"), rendered);
});

test("planned and extension boundaries still reach the event-only path", () => {
	for (const rung of ["planned", "extension"] as const) {
		const state = makeState();
		applyChatSessionAgentEvent(state, endEvent(compactionResult(rung)));
		assert.deepEqual(
			boundaryDetails(state).map((details) => details.rung),
			[rung],
		);
	}
});

test("the event-only path preserves the borrowed planner identity", () => {
	const state = makeState();
	const plannerModel = { provider: "openai", id: "gpt-5.1", thinkingLevel: "high" as const };
	applyChatSessionAgentEvent(state, endEvent(compactionResult("planned", { plannerModel })));
	assert.deepEqual(boundaryDetails(state)[0].plannerModel, plannerModel);
});

test("a malformed result is still refused", () => {
	const state = makeState();
	const broken = { ...compactionResult("fresh"), promptVersion: 2 } as unknown as VerbatimCompactionResult;
	applyChatSessionAgentEvent(state, endEvent(broken));
	assert.deepEqual(boundaryDetails(state), []);
});

test("a fresh boundary is not swallowed by an identical-text planned boundary", () => {
	// Deduplication used to compare only the boundary text, so a fresh result
	// whose text matched an existing planned boundary was dropped and the
	// degraded notice never appeared.
	const state = makeState();
	applyChatSessionAgentEvent(state, endEvent(compactionResult("planned")));
	applyChatSessionAgentEvent(state, endEvent(compactionResult("fresh")));

	const rungs = boundaryDetails(state).map((details) => details.rung);
	assert.deepEqual(rungs, ["planned", "fresh"]);

	const rendered = stripVTControlCharacters(
		new CompactionBoundaryMessageComponent({
			text: "[User]: retained\n(filtered 12 lines)",
			stats: boundaryDetails(state)[1].stats,
			rung: boundaryDetails(state)[1].rung,
		})
			.render(200)
			.join("\n"),
	);
	assert.ok(rendered.includes("✻ Context cleared (compaction degraded)"), rendered);
});

test("a repeated same-rung, same-text result is still deduplicated", () => {
	const state = makeState();
	applyChatSessionAgentEvent(state, endEvent(compactionResult("fresh")));
	applyChatSessionAgentEvent(state, endEvent(compactionResult("fresh")));
	assert.deepEqual(
		boundaryDetails(state).map((details) => details.rung),
		["fresh"],
	);
});

const HARD_LIMIT_ERROR =
	"Post-tool context remains over the provider hard input limit after compaction (9000 > 8000 tokens); the next provider request was not sent.";

test("a committed fresh boundary stays visible when the final gate also errors", () => {
	// The post-tool gate can fail *after* the boundary was persisted, so the event
	// carries both a result and an error. Suppressing the boundary there hid a
	// durable context destruction behind an error line.
	const state = makeState();
	assert.equal(applyChatSessionAgentEvent(state, endEvent(compactionResult("fresh"), HARD_LIMIT_ERROR)), true);

	const details = boundaryDetails(state);
	assert.equal(details.length, 1);
	assert.equal(details[0].rung, "fresh");
	// The error is still reported as the status.
	assert.equal(state.statusMessage, HARD_LIMIT_ERROR);

	const rendered = stripVTControlCharacters(
		new CompactionBoundaryMessageComponent({
			text: "[User]: retained\n(filtered 12 lines)",
			stats: details[0].stats,
			rung: details[0].rung,
		})
			.render(200)
			.join("\n"),
	);
	assert.ok(rendered.includes("✻ Context cleared (compaction degraded)"), rendered);
});

test("a failure with no result still appends no boundary", () => {
	const state = makeState();
	applyChatSessionAgentEvent(state, {
		type: "compaction_end",
		reason: "overflow",
		result: undefined,
		aborted: false,
		willRetry: false,
		errorMessage: "Compaction failed: 429 Too Many Requests",
	} as AgentSessionEvent);
	assert.deepEqual(boundaryDetails(state), []);
});

test("an aborted compaction with a result appends no boundary", () => {
	const state = makeState();
	applyChatSessionAgentEvent(state, {
		type: "compaction_end",
		reason: "overflow",
		result: compactionResult("fresh"),
		aborted: true,
		willRetry: false,
	} as AgentSessionEvent);
	assert.deepEqual(boundaryDetails(state), []);
});
