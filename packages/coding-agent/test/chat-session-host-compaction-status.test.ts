import assert from "node:assert/strict";
import type { EditorTheme } from "@earendil-works/pi-tui";
import { type Component, Text } from "@earendil-works/pi-tui";
import { describe, expect, it, test } from "vitest";
import type { CompactionReason } from "../src/core/agent-session.ts";
import { ChatSessionHost } from "../src/modes/interactive/components/chat-session-host.ts";
import { compactionStatusMessage } from "../src/modes/interactive/components/chat-session-host-events.ts";
import { renderChatSessionWorkingStatus } from "../src/modes/interactive/components/chat-session-host-rendering.ts";
import { ChatSessionHostState } from "../src/modes/interactive/components/chat-session-host-state.ts";
import type {
	ChatSessionHostOpts,
	ChatSessionHostStyle,
} from "../src/modes/interactive/components/chat-session-host-types.ts";

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

function makeState(overrides: Partial<ChatSessionHostOpts> = {}): ChatSessionHostState {
	const opts: ChatSessionHostOpts = {
		style,
		editorTheme,
		isStreaming: () => true,
		...overrides,
	};
	return new ChatSessionHostState(opts, {
		renderEntry: (): Component => new Text("", 0, 0),
		transcriptCacheKey: () => "",
	});
}

function makeHost(overrides: Partial<ChatSessionHostOpts> = {}): ChatSessionHost {
	return new ChatSessionHost({
		style,
		editorTheme,
		isStreaming: () => true,
		...overrides,
	});
}

const labels: Readonly<Record<CompactionReason, string>> = {
	manual: "Compacting context...",
	threshold: "Auto-compacting...",
	overflow: "Context overflow detected. Auto-compacting...",
	branchSummary: "summarizing branch…",
};

describe("chat session compaction status", () => {
	it("renders Atomic's ∀ indicator with an escape cancel hint", () => {
		const state = makeState();
		state.compacting = true;
		state.statusMessage = "Auto-compacting...";

		const rendered = renderChatSessionWorkingStatus(state, 80).join("\n");

		expect(rendered).toContain("∀");
		expect(rendered).toContain("Auto-compacting... (esc Cancel)");
	});

	it("uses the host keybinding display for the cancel hint", () => {
		const state = makeState({ getActionKeyDisplay: () => "ctrl+c" });
		state.compacting = true;

		const rendered = renderChatSessionWorkingStatus(state, 80).join("\n");

		expect(rendered).toContain("Compacting context... (ctrl+c Cancel)");
	});
});

test("rehydrates reason-specific labels for every compaction reason", () => {
	for (const [reason, label] of Object.entries(labels) as Array<[CompactionReason, string]>) {
		const host = makeHost();
		host.hydrateCompactionStatus(reason);
		const rendered = host.renderWorkingStatus(100).join("\n");

		if (reason === "branchSummary") {
			assert.equal(host.statusText(), "");
			assert.equal(host.isCompacting(), false);
			assert.match(rendered, /Working\.\.\./);
			assert.doesNotMatch(rendered, /summarizing branch…/);
		} else {
			assert.equal(host.statusText(), label);
			assert.match(rendered, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.doesNotMatch(rendered, /Working\.\.\./);
		}
		host.dispose();
	}
});

test("clears the label on compaction_end and on a non-compacting attach", () => {
	const host = makeHost();
	host.hydrateCompactionStatus("threshold");
	assert.match(host.renderWorkingStatus(100).join("\n"), /Auto-compacting\.\.\./);

	host.hydrateCompactionStatus(undefined);
	assert.equal(host.statusText(), "");
	assert.equal(host.isCompacting(), false);
	assert.doesNotMatch(host.renderWorkingStatus(100).join("\n"), /compacting/i);
	host.dispose();

	const endedHost = makeHost();
	endedHost.hydrateCompactionStatus("threshold");
	endedHost.applyAgentEvent({
		type: "compaction_end",
		reason: "threshold",
		result: undefined,
		aborted: false,
		willRetry: false,
	});
	assert.equal(endedHost.statusText(), "");
	assert.equal(endedHost.isCompacting(), false);
	assert.doesNotMatch(endedHost.renderWorkingStatus(100).join("\n"), /compacting/i);
	endedHost.dispose();
});

test("live events and re-attach hydration use the same status mapping and busy state", () => {
	for (const reason of Object.keys(labels) as CompactionReason[]) {
		const liveHost = makeHost({ isStreaming: () => false });
		if (reason === "branchSummary") {
			liveHost.applyAgentEvent({
				type: "summarization_retry_attempt_start",
				source: "branchSummary",
			});
		} else {
			liveHost.applyAgentEvent({ type: "compaction_start", reason });
		}
		const reattachedHost = makeHost({ isStreaming: () => false });
		reattachedHost.hydrateCompactionStatus(reason);

		assert.equal(liveHost.statusText(), compactionStatusMessage(reason));
		assert.equal(liveHost.isCompacting(), reason !== "branchSummary");
		if (reason === "branchSummary") {
			assert.equal(reattachedHost.statusText(), "");
			assert.equal(reattachedHost.isCompacting(), false);
			assert.doesNotMatch(reattachedHost.renderBody(100, 3).join("\n"), /summarizing branch…/);
		} else {
			assert.equal(reattachedHost.statusText(), compactionStatusMessage(reason));
			assert.equal(reattachedHost.isCompacting(), true);
			assert.equal(reattachedHost.isStreaming(), liveHost.isStreaming());
			assert.match(reattachedHost.renderWorkingStatus(100).join("\n"), /Cancel/);
		}
		liveHost.dispose();
		reattachedHost.dispose();
	}
});

test("branch-summary hydration leaves the ordinary working spinner available", () => {
	const host = makeHost();
	host.hydrateCompactionStatus("branchSummary");

	assert.equal(host.statusText(), "");
	assert.equal(host.isCompacting(), false);
	const rendered = host.renderWorkingStatus(100).join("\n");
	assert.match(rendered, /∀/);
	assert.match(rendered, /Working\.\.\./);
	assert.doesNotMatch(rendered, /summarizing branch…/);
	host.dispose();
});
