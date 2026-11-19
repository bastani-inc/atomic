import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "@bastani/atomic-tui";
import { afterAll, beforeAll, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { CustomMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/custom-message.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { isMessage } from "../../packages/intercom/broker/client-message-validation.ts";
import { buildMessageSendSignature } from "../../packages/intercom/broker/send-signature.ts";
import {
	buildIncomingCustomMessage,
	frameDeliveryFeedback,
	frameHistoricalSupervisorUpdate,
	framePreStartPendingStageMessage,
} from "../../packages/intercom/incoming-message-delivery.ts";
import intercom from "../../packages/intercom/index.ts";
import intercomHeavy from "../../packages/intercom/index-heavy.ts";
import {
	type ChildOrchestratorMetadata,
	extractProjectedDisplayText,
	formatChildOrchestratorMessage,
	formatChildOrchestratorMessagePayload,
	formatSupervisorInterviewPayload,
	formatSupervisorInterviewRequest,
	type InboundMessageEntry,
	type SupervisorInterviewRequest,
} from "../../packages/intercom/intercom-utils.ts";
import { frameOutboundAskReply } from "../../packages/intercom/outbound-asks.ts";
import type { Message, SessionInfo } from "../../packages/intercom/types.ts";
import { InlineMessageComponent, renderIntercomCustomMessage } from "../../packages/intercom/ui/inline-message.ts";

const originalKeybindings = getKeybindings();

beforeAll(() => {
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	setKeybindings(originalKeybindings);
});

const from: SessionInfo = {
	id: "f996d39d-5efd-41f7-8b01-22769b77873f",
	name: "worker-2",
	model: "fixture/model",
	cwd: "/workspace/atomic-wt/fix-x",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};

const fixedTimestamp = new Date(2026, 10, 17, 5, 41, 0).getTime();

function message(text: string, overrides: Partial<Message> = {}): Message {
	return {
		id: "markdown-message",
		timestamp: fixedTimestamp,
		content: { text, ...(overrides.content ?? {}) },
		...overrides,
	};
}

for (const themeName of ["dark", "light"] as const) {
	test(`Intercom message bodies render markdown without executing peer terminal controls or borders (${themeName}, #5224, #5350)`, () => {
		initTheme(themeName, false);
		const body =
			"Finished the **ship_rows** migration; `npm run check` passes.\n\n- Inspect `sample.ts`\n\n```text\n**literal markers**\n```\n[docs](https://example.com/docs) ![diagram](https://example.com/img.png)\n\u001b]52;c;c2FtcGxl\u0007\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007 Safe text";
		const component = new InlineMessageComponent(from, message(body), theme, {
			expanded: true,
			currentCwd: "/workspace/atomic",
		});
		for (const width of [80, 160]) {
			const lines = component.render(width);
			const raw = lines.join("\n");
			const plain = stripTerminalSequences(raw);
			assert.match(plain, /^ › Message from worker-2 · atomic-wt\/fix-x · 05:41/m);
			assert.doesNotMatch(plain, /\*\*ship_rows\*\*/);
			assert.match(plain, /ship_rows/);
			assert.match(plain, /\*\*literal markers\*\*/);
			assert.doesNotMatch(plain, /`sample\.ts`/);
			assert.match(plain, /docs \(https:\/\/example\.com\/docs\)/);
			assert.match(plain, /\[image\]/);
			assert.match(plain, /Safe text/);
			assert.ok(!raw.includes("\u001b]52;"));
			assert.ok(!raw.includes("\u001b]8;;"));
			assert.ok(!/48;|\u001b\[4[0-7]m/.test(raw));
			assert.doesNotMatch(plain, /[╭╮╰╯│📨📎↩↳]/u);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	});
}

test("inbound card derives framing from structured details without parsing body and keeps model-facing content byte-identical (#5350)", () => {
	initTheme("dark", false);
	const body = "Update with **bold**, `code`, and:\n- item 1";
	const baseEntry: InboundMessageEntry = {
		from,
		message: message(body),
		bodyText: body,
	};

	const supervisorFramed = frameHistoricalSupervisorUpdate({ ...baseEntry, channel: "supervisor" });
	const supervisorCustom = buildIncomingCustomMessage(supervisorFramed);
	assert.equal(
		supervisorCustom.content,
		`**📨 From worker-2** (/workspace/atomic-wt/fix-x)\n\n**Historical supervisor update — snapshot at send time**\n\nSent: ${new Date(fixedTimestamp).toISOString()}\n\nThis is not current task status; a later correction or final result supersedes this update.\n\n${body}`,
	);
	const supervisorCard = stripTerminalSequences(
		new InlineMessageComponent(supervisorFramed.from, supervisorFramed.message, theme, {
			channel: supervisorFramed.channel,
			currentCwd: "/other/cwd",
		})
			.render(120)
			.join("\n"),
	);
	assert.match(supervisorCard, /› Message from worker-2 · atomic-wt\/fix-x · update sent 05:41/);
	assert.doesNotMatch(supervisorCard, /Historical supervisor update/);
	assert.doesNotMatch(supervisorCard, /\*\*bold\*\*/);
	assert.match(supervisorCard, /Update with bold/);

	const refusalMsg = message("Recipient busy in non-interactive mode.", {
		replyTo: "ask-1234",
		replyError: "Recipient busy in non-interactive mode.",
	});
	const failedFramed = frameDeliveryFeedback({
		from,
		message: refusalMsg,
		replyCommand: 'intercom({ action: "reply", message: "..." })',
		bodyText: refusalMsg.content.text,
	});
	const failedCustom = buildIncomingCustomMessage(failedFramed);
	assert.equal(
		failedCustom.content,
		`**📨 From worker-2** (/workspace/atomic-wt/fix-x)\n\n**Intercom delivery failed**\n\nSent: ${new Date(fixedTimestamp).toISOString()}\n\nRecipient busy in non-interactive mode.`,
	);
	const failedCard = stripTerminalSequences(
		new InlineMessageComponent(failedFramed.from, failedFramed.message, theme, { currentCwd: "/other/cwd" })
			.render(120)
			.join("\n"),
	);
	assert.match(failedCard, /✗ Delivery failed · to worker-2 · 05:41/);
	assert.doesNotMatch(failedCard, /Intercom delivery failed/);

	const preStartFramed = framePreStartPendingStageMessage(baseEntry);
	assert.equal(preStartFramed.receivedBeforeStart, true);
	const preStartCustom = buildIncomingCustomMessage(preStartFramed);
	assert.equal(
		preStartCustom.content,
		`**📨 From worker-2** (/workspace/atomic-wt/fix-x)\n\n**Messages received before you started**\n\nSent: ${new Date(fixedTimestamp).toISOString()}\n\n${body}`,
	);
	const preStartCard = stripTerminalSequences(
		new InlineMessageComponent(preStartFramed.from, preStartFramed.message, theme, {
			receivedBeforeStart: preStartFramed.receivedBeforeStart,
			currentCwd: "/other/cwd",
		})
			.render(120)
			.join("\n"),
	);
	assert.match(preStartCard, /› Message from worker-2 · atomic-wt\/fix-x · 05:41 · sent before you started/);
	assert.doesNotMatch(preStartCard, /Messages received before you started/);

	const askMsg = message("Can you check `config.ts`?", {
		expectsReply: true,
		content: {
			text: "Can you check `config.ts`?",
			attachments: [{ type: "file", name: "report.md", content: "x".repeat(4300) }],
		},
	});
	const askCard = stripTerminalSequences(
		new InlineMessageComponent(
			from,
			askMsg,
			theme,
			'intercom({ action: "reply", message: "..." })',
			undefined,
			undefined,
			{
				currentCwd: "/other/cwd",
			},
		)
			.render(120)
			.join("\n"),
	);
	assert.match(askCard, /› Message from worker-2 · atomic-wt\/fix-x · 05:41 · asks for a reply/);
	assert.match(askCard, /⎿ {2}Attachment · report\.md · 4\.2 KB/);
	assert.match(askCard, /⎿ {2}Reply with intercom reply/);
	assert.doesNotMatch(askCard, /To reply:/);

	const replyMsg = message("Checked `config.ts`.", { replyTo: "ask-uuid-1234" });
	const replyFramed = frameOutboundAskReply(
		{ from: { ...from, name: undefined }, message: replyMsg, bodyText: replyMsg.content.text },
		{
			ask: {
				askId: "ask-uuid-1234",
				sessionId: "self",
				to: "worker-2",
				recipientId: from.id,
				question: "Did you check config.ts?",
				askedAt: 1,
			},
			state: "pending",
		},
	);
	assert.match(buildIncomingCustomMessage(replyFramed).content, /^Reply to your ask ask-uuid-1234/);
	const replyCard = stripTerminalSequences(
		new InlineMessageComponent(replyFramed.from, replyFramed.message, theme, {
			currentCwd: from.cwd,
		})
			.render(120)
			.join("\n"),
	);
	assert.match(replyCard, /› Reply from f996d39d · 05:41/);
	assert.doesNotMatch(replyCard, /atomic-wt\/fix-x/);
	assert.doesNotMatch(replyCard, /ask-uuid-1234|Reply to/);
});

test("sender-owned display projection hides contact_supervisor machine headers, UPDATE prefix, question ids and JSON reply instructions while keeping model content byte-identical (#5350)", () => {
	initTheme("dark", false);
	const metadata: ChildOrchestratorMetadata = {
		orchestratorTarget: "parent-session",
		runId: "run-9876",
		agent: "worker",
		index: "0",
		sessionName: "subagent-worker-9876-1",
	};

	const updateMessage =
		"UPDATE: Finished **ship_rows** migration; `npm run check` passes.\n- [guide](https://example.com/guide)";
	const updatePayload = formatChildOrchestratorMessagePayload("update", metadata, updateMessage);
	assert.equal(updatePayload.text, formatChildOrchestratorMessage("update", metadata, updateMessage));
	const updateInbound: InboundMessageEntry = frameHistoricalSupervisorUpdate({
		from,
		channel: "supervisor",
		bodyText: updatePayload.text,
		message: {
			id: "sup-update-1",
			timestamp: fixedTimestamp,
			content: { text: updatePayload.text, displayRanges: updatePayload.displayRanges },
		},
	});
	const updateCustom = buildIncomingCustomMessage(updateInbound);
	assert.match(updateCustom.content, /Historical supervisor update — snapshot at send time/);
	assert.match(
		updateCustom.content,
		/Subagent progress update\.\nRun: run-9876\nAgent: worker\nChild index: 0\nChild intercom target: subagent-worker-9876-1/,
	);
	assert.match(updateCustom.content, /UPDATE: Finished \*\*ship_rows\*\* migration/);
	const updateRendered = renderIntercomCustomMessage(
		{ ...updateCustom, role: "custom", timestamp: fixedTimestamp },
		{ expanded: true, outputPad: 1, keyText: () => "ctrl+o", keyHint: () => "ctrl+o to expand" },
		theme,
	)!
		.render(120)
		.join("\n");
	const updatePlain = stripTerminalSequences(updateRendered);
	assert.match(updatePlain, /› Message from worker-2 · atomic-wt\/fix-x · update sent 05:41/);
	assert.match(updatePlain, /Finished ship_rows migration; npm run check passes\./);
	assert.match(updatePlain, /guide \(https:\/\/example\.com\/guide\)/);
	assert.ok(!updateRendered.includes("\u001b]8;;"));
	assert.doesNotMatch(
		updatePlain,
		/Historical supervisor update|Subagent progress update|Run: run-9876|Agent: worker|Child index:|Child intercom target:|UPDATE:/,
	);

	const askQuestion = "Should we enforce **strict** validation on `user_id`?";
	const askPayload = formatChildOrchestratorMessagePayload("ask", metadata, askQuestion);
	assert.equal(askPayload.text, formatChildOrchestratorMessage("ask", metadata, askQuestion));
	const askInbound: InboundMessageEntry = {
		from,
		channel: "supervisor",
		replyCommand: 'intercom({ action: "reply", message: "..." })',
		bodyText: askPayload.text,
		message: {
			id: "sup-ask-1",
			timestamp: fixedTimestamp,
			expectsReply: true,
			content: { text: askPayload.text, displayRanges: askPayload.displayRanges },
		},
	};
	const askRendered = stripTerminalSequences(
		renderIntercomCustomMessage(
			{ ...buildIncomingCustomMessage(askInbound), role: "custom", timestamp: fixedTimestamp },
			{ expanded: true, outputPad: 1, keyText: () => "ctrl+o", keyHint: () => "ctrl+o to expand" },
			theme,
		)!
			.render(120)
			.join("\n"),
	);
	assert.match(askRendered, /› Message from worker-2 · atomic-wt\/fix-x · 05:41 · asks for a reply/);
	assert.match(askRendered, /Should we enforce strict validation on user_id\?/);
	assert.match(askRendered, /⎿ {2}Reply with intercom reply/);
	assert.doesNotMatch(
		askRendered,
		/Subagent needs a supervisor decision|Run: run-9876|Child index:|Child intercom target:/,
	);

	const interview: SupervisorInterviewRequest = {
		title: "Database **migration**",
		description: "Select target settings.",
		questions: [
			{
				id: "q_engine",
				type: "single",
				question: "Which **engine** should we target?",
				context: "Must support `WAL`.",
				options: ["SQLite", "Postgres"],
			},
		],
	};
	const interviewPayload = formatSupervisorInterviewPayload(metadata, interview, "Blocking on storage choice");
	assert.equal(
		interviewPayload.text,
		formatChildOrchestratorMessage(
			"interview",
			metadata,
			formatSupervisorInterviewRequest(interview, "Blocking on storage choice"),
		),
	);
	const interviewInbound: InboundMessageEntry = {
		from,
		channel: "supervisor",
		replyCommand: 'intercom({ action: "reply", message: "..." })',
		bodyText: interviewPayload.text,
		message: {
			id: "sup-interview-1",
			timestamp: fixedTimestamp,
			expectsReply: true,
			content: { text: interviewPayload.text, displayRanges: interviewPayload.displayRanges },
		},
	};
	const interviewRendered = stripTerminalSequences(
		renderIntercomCustomMessage(
			{ ...buildIncomingCustomMessage(interviewInbound), role: "custom", timestamp: fixedTimestamp },
			{ expanded: true, outputPad: 1, keyText: () => "ctrl+o", keyHint: () => "ctrl+o to expand" },
			theme,
		)!
			.render(120)
			.join("\n"),
	);
	assert.match(interviewRendered, /Interview: Database migration/);
	assert.match(interviewRendered, /Select target settings\./);
	assert.match(interviewRendered, /Child note: Blocking on storage choice/);
	assert.match(interviewRendered, /1\. Which engine should we target\?/);
	assert.match(interviewRendered, /Context: Must support WAL\./);
	assert.match(interviewRendered, /SQLite/);
	assert.doesNotMatch(
		interviewRendered,
		/Subagent requests a structured supervisor interview|Run: run-9876|\[q_engine\]|\(single\)|Supervisor reply instructions:|"responses"/,
	);

	assert.equal(extractProjectedDisplayText({ text: "Legacy raw body" }), "Legacy raw body");
	assert.equal(
		extractProjectedDisplayText({ text: "prefix body", displayRanges: [{ start: 7, end: 999 }] }),
		"prefix body",
	);
	assert.equal(
		extractProjectedDisplayText({ text: "Legacy fallback", displayRanges: [{ start: 10, end: 3 }] }),
		"Legacy fallback",
	);
	assert.equal(
		extractProjectedDisplayText({
			text: "amplification guard",
			displayRanges: Array.from({ length: 100 }, () => ({ start: 0, end: 19 })),
		}),
		"amplification guard",
	);
	assert.equal(
		extractProjectedDisplayText({
			text: "reversed ranges fallback",
			displayRanges: [
				{ start: 9, end: 15 },
				{ start: 0, end: 8 },
			],
		}),
		"reversed ranges fallback",
	);
	const emojiText = "A😀B";
	const splitEmojiFallback = extractProjectedDisplayText({
		text: emojiText,
		displayRanges: [{ start: 2, end: 4 }],
	});
	assert.equal(splitEmojiFallback, emojiText);
	assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(splitEmojiFallback));

	for (const invalidDisplayRanges of [
		[{ start: -1, end: 5 }],
		[{ start: 0, end: 1.5 }],
		[{ start: 0, end: 999 }],
		[
			{ start: 0, end: 5 },
			{ start: 3, end: 8 },
		],
		"not-an-array",
	]) {
		const candidate = {
			id: "interop-msg",
			timestamp: fixedTimestamp,
			content: { text: "Valid model text must never be dropped", displayRanges: invalidDisplayRanges },
		};
		assert.equal(isMessage(candidate), true);
		assert.equal(
			extractProjectedDisplayText(candidate.content as Message["content"]),
			"Valid model text must never be dropped",
		);
	}

	const baseSignMsg: Message = {
		id: "sig-msg",
		timestamp: fixedTimestamp,
		content: { text: updatePayload.text },
	};
	const projectedSignMsg: Message = {
		...baseSignMsg,
		content: { text: updatePayload.text, displayRanges: updatePayload.displayRanges },
	};
	assert.equal(
		buildMessageSendSignature("parent-session", baseSignMsg, from.id),
		buildMessageSendSignature("parent-session", projectedSignMsg, from.id),
	);
	assert.notEqual(
		buildMessageSendSignature("parent-session", projectedSignMsg, from.id),
		buildMessageSendSignature(
			"parent-session",
			{ ...projectedSignMsg, content: { ...projectedSignMsg.content, text: `${updatePayload.text}!` } },
			from.id,
		),
	);
	assert.notEqual(
		buildMessageSendSignature("parent-session", projectedSignMsg, from.id),
		buildMessageSendSignature(
			"parent-session",
			{
				...projectedSignMsg,
				content: {
					...projectedSignMsg.content,
					attachments: [{ type: "file", name: "a.txt", content: "x" }],
				},
			},
			from.id,
		),
	);
});

test("inbound card collapses >4 rendered rows to 3 rows + hint and shows full body when <=4 rows or expanded (#5350)", () => {
	initTheme("dark", false);
	const fourRowMsg = message("row 1\nrow 2\nrow 3\nrow 4");
	const fourRowsRendered = stripTerminalSequences(
		new InlineMessageComponent(from, fourRowMsg, theme).render(120).join("\n"),
	);
	assert.match(fourRowsRendered, /row 4/);
	assert.doesNotMatch(fourRowsRendered, /\+1 line/);

	const twentyRowText = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
	const twentyRowMsg = message(twentyRowText);
	const collapsed = stripTerminalSequences(
		new InlineMessageComponent(from, twentyRowMsg, theme, { expanded: false }).render(120).join("\n"),
	);
	assert.match(collapsed, /line 1\n {3}line 2\n {3}line 3\n {3}… \+17 lines \(ctrl\+o to expand\)/);
	assert.doesNotMatch(collapsed, /line 4/);

	const expanded = stripTerminalSequences(
		new InlineMessageComponent(from, twentyRowMsg, theme, { expanded: true }).render(120).join("\n"),
	);
	assert.match(expanded, /line 20/);
	assert.doesNotMatch(expanded, /\+17 lines/);

	const narrow = stripTerminalSequences(new InlineMessageComponent(from, twentyRowMsg, theme).render(18).join("\n"));
	assert.equal(narrow.split("\n").length, 1);
	assert.ok(narrow.endsWith("…"));
});

test("embedded message cards compare sender paths with the receiving chat's cwd (#5350)", () => {
	initTheme("dark", false);
	const entry = {
		from: { ...from, cwd: "/workspace/child" },
		message: message("Fixture body"),
		bodyText: "Fixture body",
	};
	const injected = buildIncomingCustomMessage(entry);
	let renderer: ConstructorParameters<typeof CustomMessageComponent>[1];
	intercom({
		on() {},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer(type: string, value: NonNullable<typeof renderer>) {
			if (type === "intercom_message") renderer = value;
		},
		events: { on: () => () => {}, emit() {} },
	} as never);
	assert.ok(renderer);
	const component = new CustomMessageComponent(
		{ ...injected, role: "custom", timestamp: 1 },
		renderer,
		undefined,
		1,
		true,
		[],
		undefined,
		undefined,
		{ cwd: "/workspace/child" },
	);
	try {
		const header = component
			.render(160)
			.map(stripTerminalSequences)
			.find((row) => row.includes("Message from"))!;
		assert.doesNotMatch(header, /workspace\/child/);
	} finally {
		component.dispose();
	}
});

test("render-only Supervisor registration fills metadata-only tool definitions (#5350)", () => {
	initTheme("dark", false);
	let resolver: import("../../packages/coding-agent/src/core/extensions/types.ts").ToolRendererResolver | undefined;
	intercom({
		on() {},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer(value: NonNullable<typeof resolver>) {
			resolver = value;
		},
		events: { on: () => () => {}, emit() {} },
	} as never);
	assert.ok(resolver);
	const definition = resolver("contact_supervisor", () => ({ label: "Contact Supervisor" }));
	assert.ok(definition?.renderCall);
	assert.ok(definition?.renderResult);
	const custom = { renderResult: () => ({ render: () => ["private projection"], invalidate() {} }) };
	assert.equal(
		resolver("contact_supervisor", () => custom),
		custom,
	);
});

test("main chat and subagent view resolve the same intercom_message card component (#5350)", () => {
	initTheme("dark", false);
	let lightRenderer: ConstructorParameters<typeof CustomMessageComponent>[1];
	let heavyRenderer: ConstructorParameters<typeof CustomMessageComponent>[1];
	intercom({
		on() {},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer(type: string, renderer: ConstructorParameters<typeof CustomMessageComponent>[1]) {
			if (type === "intercom_message") lightRenderer = renderer;
		},
		events: { on: () => () => {}, emit() {} },
	} as never);
	intercomHeavy({
		on() {},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer(type: string, renderer: ConstructorParameters<typeof CustomMessageComponent>[1]) {
			if (type === "intercom_message") heavyRenderer = renderer;
		},
		appendEntry: async () => {},
		getSessionName: () => undefined,
		sendMessage: () => {},
		events: { on: () => () => {}, emit() {} },
	} as never);
	assert.ok(lightRenderer, "lightweight intercom extension must register intercom_message renderer");
	assert.ok(heavyRenderer, "heavy intercom extension must register intercom_message renderer");

	const entry = frameHistoricalSupervisorUpdate({
		from,
		message: message("Status **green** across all checks."),
		channel: "supervisor",
		bodyText: "Status **green** across all checks.",
	});
	const customMsg = {
		role: "custom" as const,
		customType: "intercom_message",
		content: buildIncomingCustomMessage(entry).content,
		display: true,
		details: entry,
		timestamp: fixedTimestamp,
	};

	const mainLines = new CustomMessageComponent(customMsg, heavyRenderer, undefined, 1).render(100);
	const subagentLines = new CustomMessageComponent(customMsg, lightRenderer, undefined, 1).render(100);
	assert.deepEqual(mainLines, subagentLines);
	const plain = stripTerminalSequences(mainLines.join("\n"));
	assert.match(plain, /› Message from worker-2 · atomic-wt\/fix-x · update sent 05:41/);
	assert.doesNotMatch(plain, /\[intercom_message\]/);
	assert.doesNotMatch(plain, /Historical supervisor update/);
});
