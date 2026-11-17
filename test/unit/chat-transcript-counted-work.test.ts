/**
 * Render work of a stage or subagent chat is proportional to what changed, not to the transcript's length.
 *
 * Stage and subagent chats render their whole transcript through `ChatTranscriptComponent` on the shared chat host.
 * Each test builds a long transcript, renders it once, then changes it the way a live chat does and counts how many
 * entries were rendered again: the count must match the change whatever the transcript's length.
 */

import assert from "node:assert/strict";
import type { Component, EditorTheme } from "@bastani/atomic-tui";
import { beforeAll, describe, test } from "vitest";
import { ChatSessionHost, type ChatSessionHostStyle } from "../../packages/coding-agent/src/index.ts";
import {
	type ChatTranscriptCacheKeyValue,
	ChatTranscriptComponent,
	type ChatTranscriptRole,
} from "../../packages/coding-agent/src/modes/interactive/components/index.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

/** Long enough that work per entry would dwarf work per change; the main chat's own benchmark resumes this many. */
const LONG_TRANSCRIPT_ENTRIES = 10_000;
const WIDTH = 100;

interface Entry {
	readonly role: ChatTranscriptRole;
	readonly text: string;
}

function makeEntries(count: number): Entry[] {
	return Array.from({ length: count }, (_, index) => ({
		role: index % 3 === 0 ? "user" : "assistant",
		text: `entry ${index}`,
	}));
}

function countingTranscript(entries: Entry[], key: (entry: Entry) => ChatTranscriptCacheKeyValue = () => "") {
	const rendered: Entry[] = [];
	const transcript = new ChatTranscriptComponent<Entry>(
		entries,
		(entry): Component => {
			rendered.push(entry);
			return { render: () => [entry.text], invalidate: () => {} };
		},
		key,
	);
	return { transcript, rendered };
}

describe("ChatTranscriptComponent renders only what changed", () => {
	test("appending or replacing an entry renders that entry alone", () => {
		const entries = makeEntries(LONG_TRANSCRIPT_ENTRIES);
		const { transcript, rendered } = countingTranscript(entries);
		const first = transcript.measureRows(WIDTH);
		assert.equal(rendered.length, LONG_TRANSCRIPT_ENTRIES);
		assert.equal(first.rowCount, LONG_TRANSCRIPT_ENTRIES + Math.ceil(LONG_TRANSCRIPT_ENTRIES / 3) - 1);

		rendered.length = 0;
		transcript.measureRows(WIDTH);
		assert.equal(rendered.length, 0, "an unchanged transcript renders nothing");

		entries.push({ role: "assistant", text: "streamed" });
		const appended = transcript.measureRows(WIDTH);
		assert.deepEqual(
			rendered.map((entry) => entry.text),
			["streamed"],
		);
		assert.deepEqual(appended.renderRows(appended.rowCount - 1, appended.rowCount), ["streamed"]);

		rendered.length = 0;
		entries[entries.length - 1] = { role: "assistant", text: "streamed more" };
		const replaced = transcript.measureRows(WIDTH);
		assert.deepEqual(
			rendered.map((entry) => entry.text),
			["streamed more"],
		);
		assert.deepEqual(replaced.renderRows(replaced.rowCount - 1, replaced.rowCount), ["streamed more"]);
	});

	test("earlier history loaded ahead of every entry renders the loaded entries alone", () => {
		const entries = makeEntries(LONG_TRANSCRIPT_ENTRIES);
		const { transcript, rendered } = countingTranscript(entries);
		transcript.measureRows(WIDTH);
		rendered.length = 0;

		const earlier: Entry[] = Array.from({ length: 50 }, (_, index) => ({
			role: "assistant",
			text: `earlier ${index}`,
		}));
		entries.unshift(...earlier);
		const measured = transcript.measureRows(WIDTH);

		assert.equal(rendered.length, earlier.length, "entries that only moved keep their rendered rows");
		assert.deepEqual(measured.renderRows(0, 2), ["earlier 0", "earlier 1"]);
		// The first old entry was a user prompt at index 0; behind the loaded history it gains its leading spacer.
		assert.deepEqual(measured.renderRows(earlier.length, earlier.length + 2), ["", "entry 0"]);
	});

	test("a key of parts re-renders an entry only when one of its parts changes", () => {
		const entries = makeEntries(LONG_TRANSCRIPT_ENTRIES);
		let revision = 0;
		const last = (entry: Entry) => entry === entries[entries.length - 1];
		const { transcript, rendered } = countingTranscript(entries, (entry) => ["settings", last(entry) ? revision : 0]);
		transcript.measureRows(WIDTH);
		rendered.length = 0;

		transcript.measureRows(WIDTH);
		assert.equal(rendered.length, 0, "equal parts in fresh arrays are the same key");
		revision += 1;
		transcript.measureRows(WIDTH);
		assert.equal(rendered.length, 1);
	});
});

const plainStyle: ChatSessionHostStyle = {
	dim: (text) => text,
	text: (text) => text,
	textMuted: (text) => text,
	accent: (text) => text,
	accentBold: (text) => text,
	rule: (_hex, text) => text,
	cursor: () => "▌",
	blank: (width) => " ".repeat(width),
	editorRuleColor: () => "#ffffff",
};

const editorTheme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
		normal: (text: string) => text,
	},
} as EditorTheme;

interface Notice {
	readonly role: "notice";
	readonly text: string;
}

const assistant = (text: string) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	api: "openai-completions",
	provider: "test",
	model: "test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
	timestamp: 0,
});

describe("a stage chat's host renders only what changed", () => {
	beforeAll(() => {
		initTheme("dark", false);
	});

	/**
	 * A host whose every rendered entry is counted: notices through `renderExtraEntry`, chat messages through the
	 * markdown theme each one asks for as it renders.
	 */
	function longHost() {
		let streaming = false;
		let notices = 0;
		let messages = 0;
		const host = new ChatSessionHost<Notice>({
			style: plainStyle,
			editorTheme,
			isStreaming: () => streaming,
			renderExtraEntry: (entry): Component => {
				notices += 1;
				return { render: () => [entry.text], invalidate: () => {} };
			},
			getMarkdownTheme: () => {
				messages += 1;
				return undefined as never;
			},
		});
		const half = LONG_TRANSCRIPT_ENTRIES / 2;
		host.appendMessages(Array.from({ length: half }, (_, index) => assistant(`message ${index}`)));
		for (let index = 0; index < half; index++) host.appendExtraEntry({ role: "notice", text: `notice ${index}` });
		host.renderBody(WIDTH, 40);
		return {
			host,
			setStreaming: (value: boolean) => {
				streaming = value;
			},
			counts: () => ({ notices, messages }),
			reset: () => {
				notices = 0;
				messages = 0;
			},
		};
	}

	test("a streamed delta renders the streaming message alone", () => {
		const chat = longHost();
		assert.deepEqual(chat.counts(), { notices: LONG_TRANSCRIPT_ENTRIES / 2, messages: LONG_TRANSCRIPT_ENTRIES / 2 });
		chat.reset();
		chat.setStreaming(true);
		chat.host.applyAgentEvent({ type: "agent_start" } as never);
		chat.host.applyAgentEvent({ type: "message_start", message: assistant("") } as never);
		for (const delta of ["one ", "two ", "three"]) {
			chat.host.applyAgentEvent({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
			} as never);
			chat.host.renderBody(WIDTH, 40);
		}
		assert.deepEqual(chat.counts(), { notices: 0, messages: 3 }, "one render of the streaming message per frame");
		chat.host.dispose();
	});

	test("a turn ending or the reader scrolling away renders no settled entry again", () => {
		const chat = longHost();
		chat.setStreaming(true);
		chat.host.applyAgentEvent({ type: "agent_start" } as never);
		chat.host.renderBody(WIDTH, 40);
		chat.reset();

		chat.setStreaming(false);
		chat.host.applyAgentEvent({ type: "agent_end", messages: [] } as never);
		chat.host.renderBody(WIDTH, 40);
		assert.deepEqual(chat.counts(), { notices: 0, messages: 0 }, "the streaming state is not part of a settled key");

		chat.host.handleScrollInput("\x1b[5~");
		chat.host.renderBody(WIDTH, 40);
		chat.host.scrollToBottom();
		chat.host.renderBody(WIDTH, 40);
		assert.deepEqual(chat.counts(), { notices: 0, messages: 0 }, "scrolling is not part of a settled key");
		chat.host.dispose();
	});
});
