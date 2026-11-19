import assert from "node:assert/strict";
import type { EditorTheme } from "@bastani/atomic-tui";
import { type Component, stripHintMarkers, Text } from "@bastani/atomic-tui";
import { describe, expect, it, test, vi } from "vitest";
import type { CompactionReason } from "../src/core/agent-session.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { ChatSessionHost } from "../src/modes/interactive/components/chat-session-host.ts";
import { compactionStatusMessage } from "../src/modes/interactive/components/chat-session-host-events.ts";
import { renderChatSessionWorkingStatus } from "../src/modes/interactive/components/chat-session-host-rendering.ts";
import { ChatSessionHostState } from "../src/modes/interactive/components/chat-session-host-state.ts";
import type {
	ChatSessionHostOpts,
	ChatSessionHostStyle,
} from "../src/modes/interactive/components/chat-session-host-types.ts";

import { initTheme } from "../src/modes/interactive/theme/theme.js";

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

		const rendered = renderChatSessionWorkingStatus(state, 80).map(stripHintMarkers).join("\n");

		expect(rendered).toContain("∀");
		expect(rendered).toMatch(/Auto-compacting\.\.\. \(\d+s · esc to cancel\)/);
	});

	it("uses the host keybinding display for the cancel hint", () => {
		const state = makeState({ getActionKeyDisplay: () => "ctrl+c" });
		state.compacting = true;

		const rendered = renderChatSessionWorkingStatus(state, 80).map(stripHintMarkers).join("\n");

		expect(rendered).toMatch(/Compacting context\.\.\. \(\d+s · ctrl\+c to cancel\)/);
	});
});

test("preserves displayed messages when retained history loading is skipped (#3658)", async () => {
	initTheme("dark");
	const host = makeHost();
	const store = new MemorySessionStore();
	try {
		host.appendMessages([{ role: "user", content: "Already displayed", timestamp: 1 }]);
		const entries = [...host.entries()];
		assert.equal(await host.loadSession(store, undefined), true);
		assert.equal(await host.loadSession(store, "missing-session"), true);
		assert.deepEqual(host.entries(), entries);
		assert.match(host.renderBody(80, 20).join("\n"), /Already displayed/);
	} finally {
		host.dispose();
	}
});

test("rehydrates reason-specific labels for every compaction reason", () => {
	for (const [reason, label] of Object.entries(labels) as Array<[CompactionReason, string]>) {
		const host = makeHost();
		host.hydrateCompactionStatus(reason);
		const rendered = host.renderWorkingStatus(100).map(stripHintMarkers).join("\n");

		if (reason === "branchSummary") {
			assert.equal(host.statusText(), "");
			assert.equal(host.isCompacting(), false);
			assert.match(rendered, /Working…/);
			assert.doesNotMatch(rendered, /summarizing branch…/);
		} else {
			assert.equal(host.statusText(), label);
			assert.match(rendered, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.doesNotMatch(rendered, /Working…/);
		}
		host.dispose();
	}
});

test("clears the label on compaction_end and on a non-compacting attach", () => {
	const host = makeHost();
	host.hydrateCompactionStatus("threshold");
	assert.match(host.renderWorkingStatus(100).map(stripHintMarkers).join("\n"), /Auto-compacting\.\.\./);

	host.hydrateCompactionStatus(undefined);
	assert.equal(host.statusText(), "");
	assert.equal(host.isCompacting(), false);
	assert.doesNotMatch(host.renderWorkingStatus(100).map(stripHintMarkers).join("\n"), /compacting/i);
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
	assert.doesNotMatch(endedHost.renderWorkingStatus(100).map(stripHintMarkers).join("\n"), /compacting/i);
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
			assert.match(reattachedHost.renderWorkingStatus(100).map(stripHintMarkers).join("\n"), /to cancel/);
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
	const rendered = host.renderWorkingStatus(100).map(stripHintMarkers).join("\n");
	assert.match(rendered, /∀/);
	assert.match(rendered, /Working…/);
	assert.doesNotMatch(rendered, /summarizing branch…/);
	host.dispose();
});

test("hydrated compaction clock uses active session start timestamp and clears stale start (#5243)", () => {
	vi.useFakeTimers();
	try {
		vi.setSystemTime(10_000);
		const compactionStartedAt: number | undefined = 4_000;
		const sessionHost = makeHost({
			getAgentSession: () => ({ compactionStartedAt }) as never,
		});
		sessionHost.hydrateCompactionStatus("threshold");
		assert.match(
			sessionHost.renderWorkingStatus(100).map(stripHintMarkers).join("\n"),
			/Auto-compacting\.\.\. \(6s · esc to cancel\)/,
		);
		sessionHost.dispose();

		const chatBoxHost = makeHost({
			getChatBoxSession: () => ({ compactionStartedAt: 3_000 }) as never,
		});
		chatBoxHost.hydrateCompactionStatus("manual");
		assert.match(
			chatBoxHost.renderWorkingStatus(100).map(stripHintMarkers).join("\n"),
			/Compacting context\.\.\. \(7s · esc to cancel\)/,
		);
		chatBoxHost.dispose();

		const explicitHost = makeHost();
		explicitHost.applyAgentEvent({ type: "compaction_start", reason: "manual" });
		vi.setSystemTime(25_000);
		explicitHost.applyAgentEvent({
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted: false,
			willRetry: false,
		});
		explicitHost.hydrateCompactionStatus(undefined);
		explicitHost.hydrateCompactionStatus("overflow", 22_000);
		assert.match(
			explicitHost.renderWorkingStatus(100).map(stripHintMarkers).join("\n"),
			/Context overflow detected\. Auto-compacting\.\.\. \(3s · esc to cancel\)/,
		);
		vi.setSystemTime(27_000);
		explicitHost.hydrateCompactionStatus("manual");
		assert.match(
			explicitHost.renderWorkingStatus(100).map(stripHintMarkers).join("\n"),
			/Compacting context\.\.\. \(0s · esc to cancel\)/,
		);
		explicitHost.dispose();

		vi.setSystemTime(0);
		let sessionCompactionStartedAt: number | undefined = 0;
		const takeoverHost = makeHost({
			getAgentSession: () => ({ compactionStartedAt: sessionCompactionStartedAt }) as never,
		});
		takeoverHost.applyAgentEvent({ type: "compaction_start", reason: "threshold" });
		vi.setSystemTime(5_000);
		sessionCompactionStartedAt = 5_000;
		vi.setSystemTime(8_000);
		assert.match(
			takeoverHost.renderWorkingStatus(100).map(stripHintMarkers).join("\n"),
			/Auto-compacting\.\.\. \(8s · esc to cancel\)/,
		);
		takeoverHost.applyAgentEvent({
			type: "compaction_end",
			reason: "threshold",
			result: undefined,
			aborted: true,
			willRetry: false,
			manualTakeoverPending: true,
		});
		assert.match(
			takeoverHost.renderWorkingStatus(100).map(stripHintMarkers).join("\n"),
			/Auto-compacting\.\.\. \(8s · esc to cancel\)/,
		);
		vi.setSystemTime(10_000);
		assert.match(
			takeoverHost.renderWorkingStatus(100).map(stripHintMarkers).join("\n"),
			/Auto-compacting\.\.\. \(10s · esc to cancel\)/,
		);
		sessionCompactionStartedAt = 10_000;
		takeoverHost.applyAgentEvent({ type: "compaction_start", reason: "manual" });
		assert.match(
			takeoverHost.renderWorkingStatus(100).map(stripHintMarkers).join("\n"),
			/Compacting context\.\.\. \(0s · esc to cancel\)/,
		);
		takeoverHost.dispose();
	} finally {
		vi.useRealTimers();
	}
});

for (const sessionId of ["shared-archive-id", ""]) {
	test(`archived chat loads ID ${JSON.stringify(sessionId)} from its selected store`, async () => {
		initTheme("dark");
		const selected = new MemorySessionStore();
		const other = new MemorySessionStore();
		const header = { id: sessionId, version: 4 as const, createdAt: new Date().toISOString(), cwd: process.cwd() };
		for (const [store, content] of [
			[selected, "selected project history"],
			[other, "other project history"],
		] as const) {
			await store.create(header, [
				{
					type: "message",
					id: "message-1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content, timestamp: 1 },
				},
			]);
		}
		const host = makeHost();
		try {
			assert.equal(await host.loadSession(selected, sessionId), true);
			const rendered = host.renderBody(100, 20).join("\n");
			assert.match(rendered, /selected project history/);
			assert.doesNotMatch(rendered, /other project history/);
		} finally {
			host.dispose();
		}
	});
}
