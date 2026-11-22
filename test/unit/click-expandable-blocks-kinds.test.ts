import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import type { Component } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import type { MessageRenderer } from "../../packages/coding-agent/src/core/extensions/types.js";
import type { TaskCompletionEnvelope } from "../../packages/coding-agent/src/core/tasks/completion.js";
import { taskCompletionMessage } from "../../packages/coding-agent/src/core/tasks/completion-message.js";
import type { TaskHeartbeatDetails } from "../../packages/coding-agent/src/core/tasks/heartbeat-notice.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	type ChatMessageEntry,
	type ChatMessageRenderOptions,
	renderChatMessageEntry,
} from "../../packages/coding-agent/src/modes/interactive/components/chat-message-renderer.js";
import {
	type ClickExpandableBlock,
	clickedBlocks,
	isClickExpandableBlock,
	toggleClickedBlocks,
} from "../../packages/coding-agent/src/modes/interactive/components/transcript-block-clicks.js";
import { StartupChatContainer } from "../../packages/coding-agent/src/modes/interactive/interactive-startup-chat-container.js";
import {
	disposeInteractiveTasks,
	refreshInteractiveTasks,
} from "../../packages/coding-agent/src/modes/interactive/interactive-task-projection.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { renderIntercomCustomMessage } from "../../packages/intercom/ui/inline-message.js";
import { ENDED_CHILD_WAKE_MESSAGE_TYPE, renderIntercomWakeMessage } from "../../packages/intercom/ui/wake-notice.js";
import { renderSubagentNotification } from "../../packages/subagents/src/extension/index.js";
import { WEB_ACCESS_MESSAGE_RENDERERS } from "../../packages/web-access/message-renderers.js";

import { taskFixture } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";

const WIDTH = 100;
const lines = (count: number, label: string) =>
	Array.from({ length: count }, (_, index) => `${label} ${index + 1}`).join("\n");

beforeAll(() => initTheme("dark", false));

/** Message renderers first-party extensions register, keyed by the custom type they draw. */
function messageRenderers(): ReadonlyMap<string, MessageRenderer> {
	const renderers = new Map<string, MessageRenderer>([
		["intercom_message", renderIntercomCustomMessage],
		[ENDED_CHILD_WAKE_MESSAGE_TYPE, renderIntercomWakeMessage],
		["subagent-notify", renderSubagentNotification as unknown as MessageRenderer],
		...Object.entries(WEB_ACCESS_MESSAGE_RENDERERS),
	]);
	return renderers;
}

const assistantMessage: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: lines(4, "pondering") },
		{ type: "text", text: "The answer." },
	],
	api: "openai-responses",
	provider: "openai",
	model: "fixture",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
};

const task = taskRecord("task-1");
const heartbeat: TaskHeartbeatDetails = {
	scheduledAt: 1,
	tasks: [1, 2, 3, 4].map((index) => ({
		taskId: `task-shell-${index}`,
		kind: "command" as const,
		title: `npm run build:${index}`,
		elapsedMs: 45 * 60_000,
		intervalMs: 15 * 60_000,
		lastActivityAgoMs: 12_000,
		output: { bytes: 4096, tail: [`compiling ${index}/900`] },
	})),
	more: [],
	moreCount: 0,
};
const completion = taskCompletionMessage(
	{
		completionId: "completion-1",
		ownerId: "owner",
		taskId: "task-1",
		terminalSequence: "7",
		result: {
			kind: "completed",
			output: { ownerId: "owner", taskId: "task-1", artifactId: "out", byteCount: "0", omittedRanges: [] },
		},
		display: false,
	} as unknown as TaskCompletionEnvelope,
	{ kind: "agent", title: "check the release", agentName: "worker" } as never,
	lines(6, "worker result line"),
);

function custom(customType: string, content: string, details: unknown): Extract<ChatMessageEntry, { kind: "custom" }> {
	return {
		role: "custom",
		kind: "custom",
		message: { role: "custom", customType, content, display: true, details, timestamp: 1 },
	};
}

const intercomFrom = {
	id: "peer-1",
	name: "worker-2",
	cwd: "/workspace",
	model: "m",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};
const intercom = (text: string) =>
	custom("intercom_message", text, {
		from: intercomFrom,
		message: { id: `intercom-${text.length}`, timestamp: 1, content: { text } },
		bodyText: text,
	});

function toolResult(
	toolCallId: string,
	text: string,
): NonNullable<Extract<ChatMessageEntry, { kind: "tool" }>["result"]> {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
		durationMs: 100,
	};
}

type Fixture<K extends ChatMessageEntry["kind"]> = {
	readonly name: string;
	readonly entry: Extract<ChatMessageEntry, { kind: K }>;
};

/**
 * One or more entries of every kind a chat draws. A new kind of entry fails to compile here until it has fixtures,
 * so a block Ctrl+O expands cannot be added without this test checking that a click expands it too.
 */
const FIXTURES: { readonly [K in ChatMessageEntry["kind"]]: readonly Fixture<K>[] } = {
	assistant: [
		{
			name: "an assistant reply with thinking",
			entry: { role: "assistant", kind: "assistant", message: assistantMessage },
		},
	],
	task: [
		{
			name: "a task row",
			entry: {
				role: "tool",
				kind: "task",
				task,
				duplicate: false,
				siblings: [task],
				activity: [],
				activityOmitted: false,
			},
		},
	],
	tool: [
		{
			name: "a tool call with long output",
			entry: {
				role: "tool",
				kind: "tool",
				toolName: "bash",
				toolCallId: "call-long",
				args: { command: "long-command" },
				result: toolResult("call-long", lines(20, "tool output")),
				argsComplete: true,
				executionStarted: true,
				startedAt: 1,
			},
		},
		{
			name: "a tool call whose output fits",
			entry: {
				role: "tool",
				kind: "tool",
				toolName: "bash",
				toolCallId: "call-short",
				args: { command: "short-command" },
				result: toolResult("call-short", "only line"),
				argsComplete: true,
				executionStarted: true,
				startedAt: 1,
			},
		},
	],
	bashExecution: [
		{
			name: "a shell command you ran",
			entry: {
				role: "tool",
				kind: "bashExecution",
				message: {
					role: "bashExecution",
					command: "user-command",
					output: lines(30, "shell output"),
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 1,
				},
			},
		},
	],
	user: [
		{
			name: "a skill block with the message typed with it",
			entry: {
				role: "user",
				kind: "user",
				text: `<skill name="release" location="/skills/release/SKILL.md">\n${lines(6, "skill step")}\n</skill>\n\nShip it`,
			},
		},
		{ name: "a typed prompt", entry: { role: "user", kind: "user", text: "Ship it" } },
	],
	custom: [
		{ name: "an Intercom message", entry: intercom(lines(12, "peer line")) },
		{ name: "a short Intercom message", entry: intercom("all of it fits") },
		{
			name: "an Intercom subagent wake notice",
			entry: custom(
				ENDED_CHILD_WAKE_MESSAGE_TYPE,
				"Resuming subagent `subagent-debugger-45255a2f-7` (45255a2f:6) for an Intercom message from subagent-worker-45255a2f-3. It stays this session's subagent: its result arrives here.",
				{
					childName: "subagent-debugger-45255a2f-7",
					childId: "45255a2f:6",
					from: { id: "133acdf4-dc40-4f80-865c-ba1931d0a8cc", name: "subagent-worker-45255a2f-3" },
					depth: 1,
				},
			),
		},
		{
			name: "a session recovery notice",
			entry: custom("session-recovery-notice", "Session recovery after restart:\n- Restored 2 tasks", {
				reason: "resume",
				notices: ["Restored 2 tasks", "Reattached Intercom"],
			}),
		},
		{
			name: "an event report notice",
			entry: custom(
				"event_report",
				`Report from event child "ci#1/build-7" (event build-7):\n\n${lines(8, "build output")}`,
				{
					subscriptionId: "sess/ci#1",
					eventId: "build-7",
					child: "ci#1/build-7",
				},
			),
		},
		{
			name: "a web search results notice",
			entry: custom("web-search-results", lines(8, "search result"), {
				curated: true,
				queryCount: 2,
				totalResults: 8,
			}),
		},
		{
			name: "a curator config notice",
			entry: custom("curator-config", "Curator disabled", { workflow: "none" }),
		},
		{
			name: "a finished-task notice",
			entry: custom(completion.customType, completion.content as string, completion.details),
		},
		{ name: "a task heartbeat", entry: custom("task-heartbeat", "♥ Task heartbeat", heartbeat) },
		{
			name: "a subagent notice",
			entry: custom("subagent-notify", "", {
				agent: "scout",
				status: "completed",
				resultPreview: lines(8, "scout said"),
			}),
		},
		{ name: "a message with no renderer", entry: custom("plain-note", "A plain note.", undefined) },
	],
	branchSummary: [
		{
			name: "a branch summary",
			entry: {
				role: "summary",
				kind: "branchSummary",
				message: { role: "branchSummary", summary: lines(5, "branch point"), fromId: "entry-1", timestamp: 1 },
			},
		},
	],
	system: [{ name: "a system line", entry: { role: "system", kind: "system", text: "Session resumed." } }],
};

/** The fixtures that draw more expanded: each must take a click; the others must ignore one. */
const EXPANDING = new Set([
	"a task row",
	"a tool call with long output",
	"a shell command you ran",
	"a skill block with the message typed with it",
	"an Intercom message",
	"an Intercom subagent wake notice",
	"a session recovery notice",
	"an event report notice",
	"a web search results notice",
	"a curator config notice",
	"a finished-task notice",
	"a task heartbeat",
	"a subagent notice",
	"a branch summary",
]);

function draw(entry: ChatMessageEntry, expanded: boolean): Component {
	const renderers = messageRenderers();
	const options: ChatMessageRenderOptions = {
		ui: { requestRender: () => {} } as ChatMessageRenderOptions["ui"],
		cwd: "/workspace",
		toolOutputExpanded: expanded,
		getCustomMessageRenderer: (customType) => renderers.get(customType),
	};
	return renderChatMessageEntry(entry, options);
}

const plain = (component: Component) => component.render(WIDTH).map((line) => stripVTControlCharacters(line).trimEnd());

test("every kind of block Ctrl+O expands takes a click on any of its rows, and a block with nothing to expand ignores it", () => {
	const checked: string[] = [];
	const all: readonly { readonly name: string; readonly entry: ChatMessageEntry }[] = Object.values(FIXTURES).flat();
	for (const { name, entry } of all) {
		const collapsed = draw(entry, false);
		const expanded = plain(draw(entry, true));
		const before = plain(collapsed);
		const expands = before.join("\n") !== expanded.join("\n");
		assert.equal(expands, EXPANDING.has(name), `${name}: ${expands ? "expands" : "does not expand"} with Ctrl+O`);
		if (!isClickExpandableBlock(collapsed)) {
			assert.ok(!expands, `${name}: Ctrl+O expands it, but a click does not`);
			continue;
		}
		const area = collapsed.clickArea(WIDTH);
		if (area === undefined) {
			assert.ok(!expands, `${name}: Ctrl+O expands it, but it names no rows a click takes`);
			continue;
		}
		// The whole block takes the click: every row but the blank ones above it.
		assert.ok(
			before.slice(0, area.start).every((line) => line === ""),
			`${name}: rows above the click area are not blank`,
		);
		// Rows below the area, such as the message typed with a skill, are not part of the block and do not change.
		const after = before.slice(area.end);
		if (expands) {
			assert.deepEqual(
				after,
				after.length === 0 ? [] : expanded.slice(-after.length),
				`${name}: rows the expansion changes take no click`,
			);
		}
		for (const row of [area.start, area.end - 1]) {
			const unit = clickedBlocks([collapsed], 0, WIDTH, row);
			assert.ok(unit, `${name}: row ${row} takes no click`);
		}
		let changed = false;
		const unit = clickedBlocks([collapsed], 0, WIDTH, area.end - 1)!;
		toggleClickedBlocks(unit, WIDTH, (expanded) => {
			changed = expanded;
		});
		assert.equal(
			changed,
			expands,
			`${name}: a click ${expands ? "did not expand it" : "changed a block with nothing to expand"}`,
		);
		assert.deepEqual(plain(collapsed), expands ? expanded : before, name);
		checked.push(name);
	}
	assert.equal(
		checked.filter((name) => EXPANDING.has(name)).length,
		EXPANDING.size,
		"every expanding fixture was clicked",
	);
});

test("a task row the main chat shows takes a click anywhere on it, and Ctrl+O still sets every row", async () => {
	const fixture = taskFixture();
	const chatContainer = new StartupChatContainer();
	chatContainer.releaseStartupOutput();
	const mode = { session: {}, chatContainer, toolOutputExpanded: false, ui: { requestRender() {} } };
	refreshInteractiveTasks(mode);
	try {
		await fixture.start("check the release");
		bindOwnerTaskStore(mode.session, fixture.store);
		refreshInteractiveTasks(mode);
		const rows = () => mode.chatContainer.render(WIDTH).map((line) => stripVTControlCharacters(line).trimEnd());
		const detailed = () => rows().some((line) => line.includes("Activity"));
		assert.ok(!detailed(), rows().join("\n"));
		const lastRow = rows().length - 1;
		const result = mode.chatContainer.handleMouse({
			type: "click",
			button: "left",
			x: 2,
			y: lastRow,
			screenX: 2,
			screenY: lastRow,
			width: WIDTH,
			height: rows().length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		});
		assert.equal(result?.handled, true);
		result?.whenSingleClick?.();
		assert.ok(detailed(), rows().join("\n"));

		// Ctrl+O sets the expansion of every block in the chat, this row's included.
		for (const child of mode.chatContainer.children) (child as Partial<ClickExpandableBlock>).setExpanded?.(false);
		assert.ok(!detailed(), `Ctrl+O sets the row again:\n${rows().join("\n")}`);
	} finally {
		disposeInteractiveTasks(mode);
		await fixture.dispose();
	}
});
