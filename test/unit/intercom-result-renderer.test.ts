import assert from "node:assert/strict";
import type { ToolDefinition, ToolRendererResolver } from "@bastani/atomic";
import { getKeybindings, setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { afterAll, beforeAll, describe, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import intercom from "../../packages/intercom/index.js";
import {
	renderContactSupervisorCall,
	renderContactSupervisorResult,
	renderIntercomCall,
	renderIntercomResult,
} from "../../packages/intercom/result-renderers.js";

const originalKeybindings = getKeybindings();

beforeAll(() => {
	setKeybindings(new KeybindingsManager());
	initTheme("dark", false);
});

afterAll(() => {
	setKeybindings(originalKeybindings);
});

function contextOf(overrides: Partial<Parameters<typeof renderIntercomResult>[3]> = {}) {
	return {
		args: {},
		toolCallId: "test-call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/workspace",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
		keyText: () => "ctrl+o",
		keyHint: () => "ctrl+o to expand",
		...overrides,
	} as Parameters<typeof renderIntercomResult>[3];
}

function renderPlainIntercom(
	details: Record<string, unknown>,
	text: string,
	overrides: Partial<Parameters<typeof renderIntercomResult>[3]> = {},
): string {
	const ctx = contextOf(overrides);
	const rendered = renderIntercomResult(
		{ content: [{ type: "text", text }], details },
		{ expanded: Boolean(ctx.expanded), isPartial: Boolean(ctx.isPartial) },
		theme,
		ctx,
	)
		.render(120)
		.join("\n");
	return stripTerminalSequences(rendered);
}

function renderPlainSupervisor(
	details: Record<string, unknown>,
	text: string,
	overrides: Partial<Parameters<typeof renderContactSupervisorResult>[3]> = {},
): string {
	const ctx = contextOf(overrides);
	const rendered = renderContactSupervisorResult(
		{ content: [{ type: "text", text }], details },
		{ expanded: Boolean(ctx.expanded), isPartial: Boolean(ctx.isPartial) },
		theme,
		ctx,
	)
		.render(120)
		.join("\n");
	return stripTerminalSequences(rendered);
}

describe("intercom and supervisor tool block rendering (#5350)", () => {
	test("renders queued sends as successful while preserving genuine delivery failures (#2784)", () => {
		const queued = renderPlainIntercom(
			{ delivered: false, queued: true, messageId: "msg-1" },
			"Message queued for workflow:stage",
			{ args: { action: "send", to: "workflow:stage", message: "hello" } },
		);
		assert.match(queued, /^ ● Intercom\(send → workflow:stage\)/m);
		assert.match(queued, /⎿ {2}Queued for workflow:stage/);
		assert.doesNotMatch(queued, /msg-1/);

		const queuedExpanded = renderPlainIntercom(
			{ delivered: false, queued: true, messageId: "msg-1" },
			"Message queued for workflow:stage",
			{ args: { action: "send", to: "workflow:stage", message: "hello **world**" }, expanded: true },
		);
		assert.match(queuedExpanded, /⎿ {2}Message\n {6}hello world/);
		assert.match(queuedExpanded, /⎿ {2}Message id msg-1/);

		const undelivered = renderPlainIntercom(
			{ delivered: false, reason: "no live session named wrker-2 (did you mean worker-2?)" },
			'Message to "wrker-2" was not delivered: no live session named wrker-2 (did you mean worker-2?)',
			{ args: { action: "send", to: "wrker-2", message: "hello" }, isError: true },
		);
		assert.match(undelivered, /^ ✗ Intercom\(send → wrker-2\) · refused/m);
		assert.match(undelivered, /⎿ {2}Refused · no live session named wrker-2 \(did you mean worker-2\?\)/);
	});

	test("renders Intercom send, pattern send, ask waiting/replied/backgrounded, reply, list, join, status and cancel (#5350)", () => {
		const delivered = renderPlainIntercom({ delivered: true, messageId: "msg-2" }, "Message sent to worker-2", {
			args: {
				action: "send",
				to: "worker-2",
				message: "hi",
				attachments: [
					{ type: "file", name: "a.ts", content: "1" },
					{ type: "file", name: "b.ts", content: "2" },
				],
			},
		});
		assert.match(delivered, /^ ● Intercom\(send → worker-2\) · 2 attachments/m);
		assert.match(delivered, /⎿ {2}Delivered$/m);

		const patternSend = renderPlainIntercom(
			{
				target: "workflow:115ee8ba/**",
				delivered: 1,
				recipients: [
					{ target: "s1", label: "s1", outcome: "queued" },
					{ target: "s2", label: "s2", outcome: "queued" },
					{ target: "s3", label: "s3", outcome: "delivered" },
				],
			},
			"Message to `workflow:115ee8ba/**` reached 3 of 3 recipients",
			{ args: { action: "send", to: "workflow:115ee8ba/**", message: "sync" } },
		);
		assert.match(patternSend, /^ ● Intercom\(send → workflow:115ee8ba\/\*\*\) · 3 recipients/m);
		assert.match(patternSend, /⎿ {2}Queued for 2 · delivered to 1/);

		const askRunning = stripTerminalSequences(
			renderIntercomCall(
				{ action: "ask", to: "worker-2", message: "status?" },
				theme,
				contextOf({ isPartial: true, durationMs: 12_000 }) as never,
			)
				.render(120)
				.join("\n"),
		);
		assert.match(askRunning, /^ ∀ Intercom\(ask → worker-2\) · 12s/m);
		assert.match(askRunning, /⎿ {2}Waiting for reply · 12s/);

		const askReplied = renderPlainIntercom(
			{ askId: "ask-1", delivered: true, replied: true },
			"**Reply from worker-2:**\nFinished **migration** and `check`:\n- line 1\n- line 2\n- line 3\n- line 4",
			{ args: { action: "ask", to: "worker-2", message: "status?" }, durationMs: 41_000 },
		);
		assert.match(askReplied, /^ ● Intercom\(ask → worker-2\) · 41s/m);
		assert.match(askReplied, /⎿ {2}Reply from worker-2\n {6}Finished migration and check:/);
		assert.doesNotMatch(askReplied, /\*\*migration\*\*/);
		assert.match(askReplied, /… \+2 lines \(ctrl\+o to expand\)/);

		const askPending = renderPlainIntercom(
			{ askId: "ask-2", delivered: true, pending: true },
			'Ask ask-2 delivered to worker-2 (busy). The ask stays pending: cancel it with intercom({ action: "cancel", askId: "ask-2" }).',
			{ args: { action: "ask", to: "worker-2", message: "status?" } },
		);
		assert.match(askPending, /^ ● Intercom\(ask → worker-2\)/m);
		assert.match(askPending, /⎿ {2}Asked · reply will arrive as a message$/m);
		assert.doesNotMatch(askPending, /ask-2|cancel/);

		const replyDone = renderPlainIntercom({ delivered: true }, "Reply sent to worker-2", {
			args: { action: "reply", to: "worker-2", message: "ack" },
		});
		assert.match(replyDone, /^ ● Intercom\(reply → worker-2\)\n {3}⎿ {2}Delivered$/m);

		const listText = [
			"**Current session** (groups: workflow:115ee8ba):",
			"- `self-id` [self, idle, group: workflow:115ee8ba] /repo (m) name: self",
			"",
			"**Other visible sessions and workflow stages:**",
			"- `peer-1` [thinking, group: workflow:115ee8ba] /repo (m) name: worker-2",
			"- `peer-2` [idle, group: workflow:115ee8ba] /repo (m) name: worker-3",
			"- `peer-3` [tool:bash, group: workflow:115ee8ba] /repo (m) name: worker-4",
		].join("\n");
		const listCollapsed = renderPlainIntercom(
			{ group: "workflow:115ee8ba", groups: ["workflow:115ee8ba"] },
			listText,
			{ args: { action: "list" } },
		);
		assert.match(
			listCollapsed,
			/^ ● Intercom\(list\)\n {3}⎿ {2}4 sessions in workflow:115ee8ba\n {6}worker-2 · busy/m,
		);

		const joinCall = stripTerminalSequences(
			renderIntercomCall({ action: "join", group: "team-a" }, theme, contextOf() as never)
				.render(120)
				.join("\n"),
		);
		assert.match(joinCall, /Intercom\(join → team-a\)/);

		const statusCall = stripTerminalSequences(
			renderIntercomCall({ action: "status" }, theme, contextOf() as never)
				.render(120)
				.join("\n"),
		);
		assert.match(statusCall, /Intercom\(status\)/);

		const cancelCall = stripTerminalSequences(
			renderIntercomCall({ action: "cancel", askId: "a1b2c3d4" }, theme, contextOf() as never)
				.render(120)
				.join("\n"),
		);
		assert.match(cancelCall, /Intercom\(cancel · a1b2c3d4\)/);
	});

	test("renders Supervisor need decision, progress update, reply markdown and structured reply parse warning (#5350)", () => {
		const waiting = stripTerminalSequences(
			renderContactSupervisorCall(
				{ reason: "need_decision", message: "Which schema?" },
				theme,
				contextOf({ isPartial: true, durationMs: 12_000 }) as never,
			)
				.render(120)
				.join("\n"),
		);
		assert.match(waiting, /^ ∀ Supervisor\(need decision\) · 12s\n {3}⎿ {2}Waiting for supervisor · 12s$/m);

		const progressDelivered = renderPlainSupervisor(
			{ delivered: true, messageId: "sup-1" },
			"Progress update sent to supervisor parent",
			{ args: { reason: "progress_update", message: "Halfway done" } },
		);
		assert.match(progressDelivered, /^ ● Supervisor\(progress update\)\n {3}⎿ {2}Delivered$/m);

		const replyWithParseIssue = renderPlainSupervisor(
			{ delivered: true, structuredReplyParseError: "missing responses array" },
			"**Reply from supervisor:**\nUse **Option A** with `strict: true`.",
			{ args: { reason: "interview_request", message: "Questions" } },
		);
		assert.match(replyWithParseIssue, /^ ● Supervisor\(interview\)/m);
		assert.match(replyWithParseIssue, /⎿ {2}Reply from supervisor\n {6}Use Option A with strict: true\./);
		assert.doesNotMatch(replyWithParseIssue, /\*\*Option A\*\*/);
		assert.match(replyWithParseIssue, /⎿ {2}! Structured reply could not be parsed · missing responses array/);
	});

	test("lightweight host registration exposes both intercom and contact_supervisor tool renderers for subagent transcripts (#5350)", () => {
		const tools = new Map<string, ToolDefinition>();
		let resolver: ToolRendererResolver | undefined;
		intercom({
			on() {},
			registerTool(tool: ToolDefinition) {
				tools.set(tool.name, tool);
			},
			registerToolRenderer(r: ToolRendererResolver) {
				resolver = r;
			},
			registerCommand() {},
			registerShortcut() {},
			registerMessageRenderer() {},
			events: { on: () => () => {}, emit() {} },
		} as never);
		assert.ok(resolver, "intercom must register a tool renderer resolver for host-viewed subagent transcripts");
		const supRenderers = resolver("contact_supervisor", () => tools.get("contact_supervisor"));
		assert.ok(supRenderers?.renderCall && supRenderers.renderResult);
		const callLines = stripTerminalSequences(
			supRenderers
				.renderCall({ reason: "progress_update", message: "hello" } as never, theme, contextOf() as never)
				.render(100)
				.join("\n"),
		);
		assert.match(callLines, /Supervisor\(progress update\)/);
	});
});
