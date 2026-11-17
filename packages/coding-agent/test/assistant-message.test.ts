import assert from "node:assert/strict";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { Container, type TUI, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import type { MarkdownTransformContext } from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import {
	chatEntriesFromAgentMessages,
	LiveChatEntriesController,
	renderChatMessageEntry,
} from "../src/modes/interactive/components/chat-message-renderer.ts";
import "../src/modes/interactive/interactive-agent-events.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

let previousColorTerm: string | undefined;

beforeEach(() => {
	previousColorTerm = process.env.COLORTERM;
	process.env.COLORTERM = "truecolor";
});

afterEach(() => {
	if (previousColorTerm === undefined) {
		delete process.env.COLORTERM;
	} else {
		process.env.COLORTERM = previousColorTerm;
	}
});

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders thinking content with the muted foreground color", () => {
		initTheme("catppuccin-mocha");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "checking options" }]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered).toContain(theme.getFgAnsi("muted"));
		expect(rendered).not.toContain(theme.getFgAnsi("thinkingText"));
	});

	test("coalesces only adjacent thinking blocks into one rendered section", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "third thought" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
				{ type: "thinking", thinking: "fourth thought" },
			]),
		);

		const markdownChildren = (
			component as unknown as { contentContainer: { children: Array<{ text?: string }> } }
		).contentContainer.children.filter((child) => child.constructor.name === "Markdown");
		expect(markdownChildren.map((child) => child.text)).toEqual([
			"first thought\n\nsecond thought",
			"answer",
			"third thought",
			"fourth thought",
		]);
	});

	test("applies a single Markdown transformer without mutating the message", () => {
		initTheme("dark");
		const contexts: MarkdownTransformContext[] = [];
		const message = createAssistantMessage([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				contexts.push(context);
				return `${context.messageType}:${markdown}`;
			},
		]);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("assistant:answer");
		expect(rendered).toContain("assistant-thinking:reasoning");
		expect(contexts).toEqual([
			{ messageType: "assistant", isStreaming: false, availableWidth: 78 },
			{ messageType: "assistant-thinking", isStreaming: false, availableWidth: 78 },
		]);
		expect(message.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
	});

	test("continues the Markdown transformer chain after a transformer throws", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "still visible" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown) => {
					calls.push("first");
					return markdown.replace("still", "remains");
				},
				() => {
					calls.push("throw");
					throw new Error("broken transformer");
				},
				(markdown) => {
					calls.push("last");
					return `${markdown} after error`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("remains visible after error");
		expect(calls).toEqual(["first", "throw", "last"]);
	});

	test("marks partial assistant Markdown as streaming", () => {
		initTheme("dark");
		const streamingStates: boolean[] = [];
		const message = createAssistantMessage([{ type: "text", text: "partial" }]);
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				streamingStates.push(context.isStreaming);
				return context.isStreaming ? markdown : `${markdown} transformed`;
			},
		]);

		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("transformed");

		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("partial transformed");
		expect(streamingStates).toEqual([true, false]);
	});

	test("renders one hidden label for each adjacent thinking run", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first" },
				{ type: "thinking", thinking: "second" },
				{ type: "text", text: "boundary" },
				{ type: "thinking", thinking: "third" },
			]),
			true,
		);
		const rendered = component.render(80).join("\n");
		expect(rendered.match(/Thinking\.\.\./g)).toHaveLength(2);
	});

	test("renders nothing for hidden thinking with an empty label (pi #11402)", () => {
		initTheme("dark");

		const thinkingOnly = new AssistantMessageComponent(
			createAssistantMessage(
				[
					{ type: "thinking", thinking: "reasoning" },
					{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
				],
				{ stopReason: "toolUse" },
			),
			true,
			undefined,
			"",
		);
		assert.deepEqual(thinkingOnly.render(80), []);

		const withText = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "reasoning" },
				{ type: "text", text: "answer" },
			]),
			true,
			undefined,
			"",
		);
		assert.deepEqual(
			withText.render(80).map((line) => stripAnsi(line).trim()),
			["", "answer"],
		);
	});

	test("keeps the label row and spacing for hidden thinking with a label", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "reasoning" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		assert.deepEqual(
			component.render(80).map((line) => stripAnsi(line).trim()),
			["", "Thinking...", "", "answer"],
		);
	});

	test("bounds long aborted assistant notices to one header row (#5350)", () => {
		initTheme("dark");
		const width = 48;
		const component = new AssistantMessageComponent(
			createAssistantMessage([], {
				stopReason: "aborted",
				errorMessage:
					'The main-chat question was dismissed because the user responded in the workflow chat for workflow "hil-interrupt-verifier" (run f8dd07bd-8073-4b3d-9bdd-ee424df90235, stage select, prompt hil-81ce5653-ac91-4a23-a6e0-b9c5ed74cdda). User responded with: Answered while main chat ask_user_question was open. Do not ask the same question again.',
			}),
		);

		const lines = component.render(width);

		expect(lines.length).toBe(2);
		assert.match(stripAnsi(lines.at(-1) ?? ""), /^ ◼ Interrupted/);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("an interrupted response ends with a stopped notice independent of provider wording (#5350)", () => {
		vi.stubEnv("NO_COLOR", undefined);
		onTestFinished(() => {
			vi.unstubAllEnvs();
		});
		initTheme("dark");
		for (const errorMessage of [
			undefined,
			"Request was aborted",
			"This operation was aborted",
			"The operation was aborted.",
			"Operation aborted",
		]) {
			const component = new AssistantMessageComponent(
				createAssistantMessage([{ type: "text", text: "partial" }], { stopReason: "aborted", errorMessage }),
			);
			const lines = component.render(80);
			const last = lines.filter((line) => stripAnsi(line).trim() !== "").at(-1) ?? "";
			assert.equal(stripAnsi(last).trim(), "◼ Interrupted · response", String(errorMessage));
			assert.equal(last.includes(theme.fg("error", "◼")), false, "not drawn as an error");
			assert.ok(last.includes(theme.fg("muted", "◼")), "stopped marker is muted");
		}
		const retried = new AssistantMessageComponent(
			createAssistantMessage([], { stopReason: "aborted", errorMessage: "Aborted after 2 retry attempts" }),
		);
		const retriedText = retried
			.render(80)
			.map((line) => stripAnsi(line).trim())
			.filter(Boolean);
		assert.deepEqual(
			retriedText.slice(-1),
			["◼ Interrupted · response"],
			"an interrupt during retries reads the same",
		);
	});

	test("an empty aborted post-tool turn names the interrupted tool across replay, live, and main entries even with native empty text/thinking blocks (#5350)", async () => {
		initTheme("dark");
		const toolTurn = createAssistantMessage(
			[
				{
					type: "toolCall",
					id: "mx-1794924149595562253-0",
					name: "bash",
					arguments: {
						command: "echo started; sleep 40; echo finished",
						timeout: 60,
						wait: {
							kind: "foreground",
							budgetMs: 60000,
						},
					},
				},
			],
			{ stopReason: "toolUse" },
		);
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "mx-1794924149595562253-0",
			toolName: "bash",
			details: {},
			content: [{ type: "text" as const, text: "started\n\n\nCommand aborted" }],
			isError: true,
			timestamp: Date.now(),
		};
		const abortedTurn = createAssistantMessage([{ type: "text", text: "" }], {
			stopReason: "aborted",
			errorMessage: "This operation was aborted",
		});
		const snapshot = structuredClone(abortedTurn);

		const replayEntries = chatEntriesFromAgentMessages([
			{ role: "user", content: "run it", timestamp: Date.now() },
			toolTurn,
			toolResult,
			abortedTurn,
		]);
		const replayAssistant = replayEntries.filter((entry) => entry.kind === "assistant").at(-1);
		assert.ok(replayAssistant);
		const replayRendered = renderChatMessageEntry(replayAssistant, {
			ui: { requestRender() {} } as Pick<TUI, "requestRender">,
			cwd: "/project",
		})
			.render(80)
			.map((line) => stripAnsi(line).trim())
			.filter(Boolean);
		assert.deepEqual(replayRendered, ["◼ Interrupted · bash"]);

		const liveEntries: Parameters<typeof renderChatMessageEntry>[0][] = [];
		const controller = new LiveChatEntriesController(liveEntries);
		controller.appendUserText("run it");
		controller.applyEvent({ type: "message_start", message: toolTurn });
		controller.applyEvent({ type: "message_end", message: toolTurn });
		controller.applyEvent({
			type: "tool_execution_start",
			toolCallId: "mx-1794924149595562253-0",
			toolName: "bash",
			args: {
				command: "echo started; sleep 40; echo finished",
				timeout: 60,
				wait: { kind: "foreground", budgetMs: 60000 },
			},
		});
		controller.applyEvent({
			type: "tool_execution_end",
			toolCallId: "mx-1794924149595562253-0",
			toolName: "bash",
			result: { details: {}, content: [{ type: "text", text: "started\n\n\nCommand aborted" }] },
			isError: true,
		});
		controller.applyEvent({ type: "message_start", message: { ...abortedTurn, stopReason: "stop" } });
		controller.applyEvent({ type: "message_end", message: abortedTurn });
		const liveAssistant = liveEntries.filter((entry) => entry.kind === "assistant").at(-1);
		assert.ok(liveAssistant);
		const liveRendered = renderChatMessageEntry(liveAssistant, {
			ui: { requestRender() {} } as Pick<TUI, "requestRender">,
			cwd: "/project",
		})
			.render(80)
			.map((line) => stripAnsi(line).trim())
			.filter(Boolean);
		assert.deepEqual(liveRendered, ["◼ Interrupted · bash"]);

		const chatContainer = new Container();
		const mode = {
			isInitialized: true,
			footer: { invalidate() {} },
			programStatus: { handleEvent() {} },
			workingRunMeter: {
				start() {},
				requestStarted() {},
				streaming() {},
				settled() {},
				stop() {},
				snapshot: () => undefined,
			},
			pendingTools: new Map(),
			settingsManager: {
				getShowTerminalProgress: () => false,
				getShowImages: () => false,
				getImageWidthCells: () => 60,
				getLatexRenderingEnabled: () => false,
				getShowCacheMissNotices: () => false,
			},
			stopWorkingLoader() {},
			workingVisible: false,
			ui: { requestRender() {}, terminal: { setProgress() {} } },
			hideThinkingBlock: false,
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			hiddenThinkingLabel: "Thinking...",
			outputPad: 1,
			getMarkdownTransformers: () => [],
			chatContainer,
			toolOutputExpanded: false,
			session: {},
			getRegisteredToolDefinition: () => undefined,
			sessionManager: { getCwd: () => "/project", getEntries: () => [] },
			maybeShowInstallChangeWarning: () => false,
			maybeShowAssistantDiagnostics() {},
			checkShutdownRequested: async () => {},
			compactionQueuedMessages: [],
		} as unknown as InteractiveModeBase;
		const emit = (event: unknown) => InteractiveModeBase.prototype.handleEvent.call(mode, event as never);
		await emit({ type: "agent_start" });
		await emit({ type: "message_start", message: { ...toolTurn, content: [] } });
		await emit({
			type: "message_update",
			message: toolTurn,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" },
		});
		await emit({ type: "message_end", message: toolTurn });
		await emit({
			type: "tool_execution_start",
			toolCallId: "mx-1794924149595562253-0",
			toolName: "bash",
			args: {
				command: "echo started; sleep 40; echo finished",
				timeout: 60,
				wait: { kind: "foreground", budgetMs: 60000 },
			},
		});
		await emit({
			type: "tool_execution_end",
			toolCallId: "mx-1794924149595562253-0",
			toolName: "bash",
			result: { details: {}, content: [{ type: "text", text: "started\n\n\nCommand aborted" }] },
			isError: true,
		});
		await emit({ type: "message_start", message: { ...abortedTurn, stopReason: "stop" } });
		await emit({ type: "message_end", message: { ...abortedTurn } });
		const mainInterruptLines = chatContainer
			.render(80)
			.map((line) => stripAnsi(line).trim())
			.filter((line) => line.startsWith("◼ Interrupted"));
		assert.deepEqual(mainInterruptLines, ["◼ Interrupted · bash"]);

		controller.appendUserText("next question");
		const freshAborted = createAssistantMessage(
			[
				{ type: "thinking", thinking: "" },
				{ type: "text", text: "" },
			],
			{
				stopReason: "aborted",
				errorMessage: "This operation was aborted",
			},
		);
		controller.applyEvent({ type: "message_start", message: { ...freshAborted, stopReason: "stop" } });
		controller.applyEvent({ type: "message_end", message: freshAborted });
		const freshAssistant = liveEntries.filter((entry) => entry.kind === "assistant").at(-1);
		assert.ok(freshAssistant);
		const freshRendered = renderChatMessageEntry(freshAssistant, {
			ui: { requestRender() {} } as Pick<TUI, "requestRender">,
			cwd: "/project",
		})
			.render(80)
			.map((line) => stripAnsi(line).trim())
			.filter(Boolean);
		assert.deepEqual(freshRendered, ["◼ Interrupted · response"]);
		assert.deepEqual(abortedTurn, snapshot);
	});

	test("excludes earlier settled tools when a later tool aborts across main, replay, and live entries (#5350)", async () => {
		initTheme("dark");
		const settledReadCall = {
			type: "toolCall" as const,
			id: "call-read-1",
			name: "read",
			arguments: { path: "a.ts" },
		};
		const settledFindCall = {
			type: "toolCall" as const,
			id: "call-find-1",
			name: "find",
			arguments: { paths: ["*"] },
		};
		const abortedBashCall = {
			type: "toolCall" as const,
			id: "call-bash-2",
			name: "bash",
			arguments: { command: "sleep 40" },
		};
		const turn1 = createAssistantMessage([settledReadCall, settledFindCall], { stopReason: "toolUse" });
		const readResult = {
			role: "toolResult" as const,
			toolCallId: "call-read-1",
			toolName: "read",
			content: [{ type: "text" as const, text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		};
		const findResult = {
			role: "toolResult" as const,
			toolCallId: "call-find-1",
			toolName: "find",
			content: [{ type: "text" as const, text: "a.ts" }],
			isError: false,
			timestamp: Date.now(),
		};
		const turn2 = createAssistantMessage([settledReadCall, abortedBashCall], { stopReason: "toolUse" });
		const bashAbortedResult = {
			role: "toolResult" as const,
			toolCallId: "call-bash-2",
			toolName: "bash",
			content: [{ type: "text" as const, text: "Command aborted" }],
			isError: true,
			timestamp: Date.now(),
		};
		const abortedTurn = createAssistantMessage([], {
			stopReason: "aborted",
			errorMessage: "Request was aborted",
		});

		const replayEntries = chatEntriesFromAgentMessages([
			{ role: "user", content: "check and run", timestamp: Date.now() },
			turn1,
			readResult,
			findResult,
			turn2,
			readResult,
			bashAbortedResult,
			abortedTurn,
		]);
		const replayAssistant = replayEntries.filter((entry) => entry.kind === "assistant").at(-1);
		assert.ok(replayAssistant);
		const replayLines = renderChatMessageEntry(replayAssistant, {
			ui: { requestRender() {} } as Pick<TUI, "requestRender">,
			cwd: "/project",
		})
			.render(80)
			.map((line) => stripAnsi(line).trim())
			.filter(Boolean);
		assert.deepEqual(replayLines, ["◼ Interrupted · bash"]);

		const chatContainer = new Container();
		const mode = {
			isInitialized: true,
			footer: { invalidate() {} },
			programStatus: { handleEvent() {} },
			workingRunMeter: {
				start() {},
				requestStarted() {},
				streaming() {},
				settled() {},
				stop() {},
				snapshot: () => undefined,
			},
			pendingTools: new Map(),
			settingsManager: {
				getShowTerminalProgress: () => false,
				getShowImages: () => false,
				getImageWidthCells: () => 60,
				getLatexRenderingEnabled: () => false,
				getShowCacheMissNotices: () => false,
			},
			stopWorkingLoader() {},
			workingVisible: false,
			ui: { requestRender() {}, terminal: { setProgress() {} } },
			hideThinkingBlock: false,
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			hiddenThinkingLabel: "Thinking...",
			outputPad: 1,
			getMarkdownTransformers: () => [],
			chatContainer,
			toolOutputExpanded: false,
			session: {},
			getRegisteredToolDefinition: () => undefined,
			sessionManager: { getCwd: () => "/project", getEntries: () => [] },
			maybeShowInstallChangeWarning: () => false,
			maybeShowAssistantDiagnostics() {},
			checkShutdownRequested: async () => {},
			compactionQueuedMessages: [],
		} as unknown as InteractiveModeBase;
		const emit = (event: unknown) => InteractiveModeBase.prototype.handleEvent.call(mode, event as never);

		await emit({ type: "agent_start" });
		await emit({ type: "message_start", message: { ...turn1, content: [] } });
		await emit({
			type: "message_update",
			message: turn1,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" },
		});
		await emit({ type: "message_end", message: turn1 });
		await emit({
			type: "tool_execution_start",
			toolCallId: "call-read-1",
			toolName: "read",
			args: { path: "a.ts" },
		});
		await emit({
			type: "tool_execution_end",
			toolCallId: "call-read-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		await emit({
			type: "tool_execution_start",
			toolCallId: "call-find-1",
			toolName: "find",
			args: { paths: ["*"] },
		});
		await emit({
			type: "tool_execution_end",
			toolCallId: "call-find-1",
			toolName: "find",
			result: { content: [{ type: "text", text: "a.ts" }] },
			isError: false,
		});
		await emit({ type: "message_start", message: { ...turn2, content: [] } });
		await emit({
			type: "message_update",
			message: turn2,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" },
		});
		await emit({ type: "message_end", message: turn2 });
		await emit({
			type: "tool_execution_start",
			toolCallId: "call-read-1",
			toolName: "read",
			args: { path: "a.ts" },
		});
		await emit({
			type: "tool_execution_end",
			toolCallId: "call-read-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		await emit({
			type: "tool_execution_start",
			toolCallId: "call-bash-2",
			toolName: "bash",
			args: { command: "sleep 40" },
		});
		await emit({
			type: "tool_execution_end",
			toolCallId: "call-bash-2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "Command aborted" }] },
			isError: true,
		});
		await emit({ type: "message_start", message: { ...abortedTurn, stopReason: "stop" } });
		await emit({ type: "message_end", message: abortedTurn });

		const mainInterruptLines = chatContainer
			.render(80)
			.map((line) => stripAnsi(line).trim())
			.filter((line) => line.startsWith("◼ Interrupted"));
		assert.deepEqual(mainInterruptLines, ["◼ Interrupted · bash"]);
	});

	test("does not name an incomplete tool from before a user boundary when a new response aborts empty (#5350)", () => {
		initTheme("dark");
		const oldIncompleteTurn = createAssistantMessage(
			[{ type: "toolCall", id: "stale-read", name: "read", arguments: { path: "stale.ts" } }],
			{ stopReason: "toolUse" },
		);
		const newAbortedTurn = createAssistantMessage([], {
			stopReason: "aborted",
			errorMessage: "Request was aborted",
		});

		const replayEntries = chatEntriesFromAgentMessages([
			{ role: "user", content: "old turn", timestamp: Date.now() - 1000 },
			oldIncompleteTurn,
			{ role: "user", content: "new turn", timestamp: Date.now() },
			newAbortedTurn,
		]);
		const replayAssistant = replayEntries.filter((entry) => entry.kind === "assistant").at(-1);
		assert.ok(replayAssistant);
		const replayLines = renderChatMessageEntry(replayAssistant, {
			ui: { requestRender() {} } as Pick<TUI, "requestRender">,
			cwd: "/project",
		})
			.render(80)
			.map((line) => stripAnsi(line).trim())
			.filter(Boolean);
		assert.deepEqual(replayLines, ["◼ Interrupted · response"]);

		const liveEntries: Parameters<typeof renderChatMessageEntry>[0][] = [];
		const controller = new LiveChatEntriesController(liveEntries);
		controller.appendUserText("old turn");
		controller.applyEvent({ type: "message_start", message: oldIncompleteTurn });
		controller.applyEvent({ type: "message_end", message: oldIncompleteTurn });
		controller.appendUserText("new turn");
		controller.applyEvent({ type: "message_start", message: { ...newAbortedTurn, stopReason: "stop" } });
		controller.applyEvent({ type: "message_end", message: newAbortedTurn });
		const liveAssistant = liveEntries.filter((entry) => entry.kind === "assistant").at(-1);
		assert.ok(liveAssistant);
		const liveLines = renderChatMessageEntry(liveAssistant, {
			ui: { requestRender() {} } as Pick<TUI, "requestRender">,
			cwd: "/project",
		})
			.render(80)
			.map((line) => stripAnsi(line).trim())
			.filter(Boolean);
		assert.deepEqual(liveLines, ["◼ Interrupted · response"]);
	});

	test("renders neutral truncation wording for a length stop", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "partial response" }], {
				stopReason: "length",
			}),
		);

		const rendered = component.render(100).join("\n");
		expect(rendered).toContain("Response was truncated before completion.");
	});

	test("renders a table that follows an unclosed display-math opener (#11159)", () => {
		initTheme("dark");
		const text = ["Intro", "", "$$", "", "| A | B |", "|---|---|", "| 1 | 2 |", "", "After"].join("\n");
		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text }]));

		const lines = component.render(80).map((line) => stripAnsi(line).trim());

		expect(lines).toEqual(expect.arrayContaining(["┌───┬───┐", "│ A │ B │", "├───┼───┤", "│ 1 │ 2 │", "└───┴───┘"]));
		expect(lines).toContain("After");
	});

	test("renders bold emphasis delimited next to CJK punctuation (#10730)", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "**这是测试。**后面" }]),
		);

		const rendered = component.render(80).map((line) => stripAnsi(line).trim());

		expect(rendered).toContain("这是测试。后面");
		expect(rendered.join("\n")).not.toContain("**");
	});
});
