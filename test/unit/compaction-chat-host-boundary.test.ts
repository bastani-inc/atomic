/**
 * The chat host's event-only fallback path must append every compaction boundary form.
 *
 * The snapshot path usually hides this: persisted messages are normally rebuilt
 * before `compaction_end` arrives. When no agent-session snapshot is available,
 * the host synthesizes the boundary from the event alone.
 */

import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Component, type EditorTheme, Text } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import type {
	CompactionForm,
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
	form: CompactionForm,
	extra: Partial<VerbatimCompactionResult> = {},
): VerbatimCompactionResult {
	return {
		compactedText: "Context cleared. Your earlier conversation (51,234 tokens) is no longer in your context window.",
		firstKeptEntryId: null,
		tokensBefore: 51_234,
		stats: {
			linesBefore: 20,
			linesDeleted: 20,
			linesKept: 0,
			rangeCount: 0,
			tokensBefore: 51_234,
			tokensAfter: 2_000,
			percentReduction: 96.1,
		},
		parameters: { query: "focus" },
		promptVersion: 7,
		form,
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

function renderedTitle(details: VerbatimCompactionDetails): string {
	return stripVTControlCharacters(
		new CompactionBoundaryMessageComponent({
			text: "Context cleared.",
			form: details.form,
			stats: details.stats,
			...(details.model ? { source: details.model } : {}),
			...(details.fallbackReason ? { fallbackReason: details.fallbackReason } : {}),
		})
			.render(200)
			.join("\n"),
	);
}

test("an event-only cleared boundary is appended, not dropped", () => {
	const state = makeState();
	assert.equal(applyChatSessionAgentEvent(state, endEvent(compactionResult("cleared"))), true);

	const details = boundaryDetails(state);
	assert.equal(details.length, 1);
	assert.equal(details[0].form, "cleared");
	assert.ok(renderedTitle(details[0]).includes("⚛ Context cleared · 51.2k tokens"), renderedTitle(details[0]));
});

test("a compacted boundary keeps its compactor model and reports both token counts", () => {
	const state = makeState();
	applyChatSessionAgentEvent(
		state,
		endEvent(compactionResult("compacted", { backend: "compactor", model: "morph/morph-compactor" })),
	);
	const details = boundaryDetails(state)[0];
	assert.equal(details.model, "morph/morph-compactor");
	assert.ok(
		renderedTitle(details).includes("⚛ Context compacted · morph/morph-compactor · 51.2k → 2.0k tokens"),
		renderedTitle(details),
	);
});

test("a compactor fallback keeps its reason on the boundary", () => {
	const state = makeState();
	applyChatSessionAgentEvent(
		state,
		endEvent(compactionResult("cleared", { fallbackReason: "morph/morph-compactor failed: HTTP 503" })),
	);
	const details = boundaryDetails(state)[0];
	assert.equal(details.fallbackReason, "morph/morph-compactor failed: HTTP 503");
	assert.ok(renderedTitle(details).includes("context cleared instead"), renderedTitle(details));
});

test("a malformed result is still refused", () => {
	const state = makeState();
	const broken = { ...compactionResult("cleared"), promptVersion: 2 } as unknown as VerbatimCompactionResult;
	applyChatSessionAgentEvent(state, endEvent(broken));
	assert.deepEqual(boundaryDetails(state), []);
});

test("a cleared boundary is not swallowed by an identical-text compacted boundary", () => {
	const state = makeState();
	applyChatSessionAgentEvent(state, endEvent(compactionResult("compacted")));
	applyChatSessionAgentEvent(state, endEvent(compactionResult("cleared")));
	assert.deepEqual(
		boundaryDetails(state).map((details) => details.form),
		["compacted", "cleared"],
	);
});

test("a repeated same-form, same-text result is still deduplicated", () => {
	const state = makeState();
	applyChatSessionAgentEvent(state, endEvent(compactionResult("cleared")));
	applyChatSessionAgentEvent(state, endEvent(compactionResult("cleared")));
	assert.deepEqual(
		boundaryDetails(state).map((details) => details.form),
		["cleared"],
	);
});

const HARD_LIMIT_ERROR =
	"Post-tool context remains over the provider hard input limit after compaction (9000 > 8000 tokens); the next provider request was not sent.";

test("a committed boundary stays visible when the final gate also errors", () => {
	const state = makeState();
	assert.equal(applyChatSessionAgentEvent(state, endEvent(compactionResult("cleared"), HARD_LIMIT_ERROR)), true);
	const details = boundaryDetails(state);
	assert.equal(details.length, 1);
	assert.equal(details[0].form, "cleared");
	assert.equal(state.statusMessage, HARD_LIMIT_ERROR);
});

test("a failure with no result still appends no boundary", () => {
	const state = makeState();
	applyChatSessionAgentEvent(state, {
		type: "compaction_end",
		reason: "overflow",
		result: undefined,
		aborted: false,
		willRetry: false,
		errorMessage: "Compaction failed: nothing to compact",
	} as AgentSessionEvent);
	assert.deepEqual(boundaryDetails(state), []);
});

test("an aborted compaction with a result appends no boundary", () => {
	const state = makeState();
	applyChatSessionAgentEvent(state, {
		type: "compaction_end",
		reason: "overflow",
		result: compactionResult("cleared"),
		aborted: true,
		willRetry: false,
	} as AgentSessionEvent);
	assert.deepEqual(boundaryDetails(state), []);
});
