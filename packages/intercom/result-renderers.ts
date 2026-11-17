import {
	collapseToolBlockLines,
	type Theme,
	TOOL_BLOCK_LIMITS,
	ToolBlock,
	ToolBlockMarkdown,
	ToolBlockRecords,
	type ToolDefinition,
} from "@bastani/atomic";
import { type Component, Text } from "@bastani/atomic-tui";
import type { PatternRecipientOutcome } from "./send-pattern-targets.js";
import { terminalSafeLabel, terminalSafeText } from "./ui/terminal-text.js";

type ToolCallRenderer = NonNullable<ToolDefinition["renderCall"]>;
type ToolResultRenderer = NonNullable<ToolDefinition["renderResult"]>;
type ToolRenderResultArgs = Parameters<ToolResultRenderer>;
type ToolRenderResult = ReturnType<ToolResultRenderer>;
type RenderedResult = ToolRenderResultArgs[0];
type RenderContext = ToolRenderResultArgs[3];
type TextContentBlock = Extract<RenderedResult["content"][number], { type: "text" }>;

interface IntercomCallArgs {
	readonly action?: unknown;
	readonly to?: unknown;
	readonly group?: unknown;
	readonly askId?: unknown;
	readonly replyTo?: unknown;
	readonly message?: unknown;
	readonly attachments?: unknown;
}

interface SupervisorCallArgs {
	readonly reason?: unknown;
	readonly message?: unknown;
	readonly interview?: unknown;
}

type IntercomResultDetails = {
	delivered?: boolean | number;
	queued?: boolean;
	error?: boolean;
	pending?: boolean;
	replied?: boolean;
	yielded?: boolean;
	cancelled?: boolean;
	messageId?: string;
	askId?: string;
	reason?: string;
	target?: string;
	group?: string;
	groups?: readonly string[];
	peekGroup?: string;
	recipients?: readonly PatternRecipientOutcome[];
};

type ContactSupervisorResultDetails = IntercomResultDetails & {
	structuredReplyParseError?: string;
};

const STARTED_AT_STATE_KEY = "intercomStartedAtMs";

function isTextContentBlock(block: RenderedResult["content"][number]): block is TextContentBlock {
	return block.type === "text";
}

function firstRawTextContent(result: RenderedResult): string {
	return result.content.find(isTextContentBlock)?.text ?? "";
}

function formatElapsed(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 1000) return undefined;
	const totalSeconds = Math.floor(durationMs / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	if (totalSeconds < 3600) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	}
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function resolveRunningElapsedMs(context: Partial<RenderContext> | undefined): number | undefined {
	if (typeof context?.durationMs === "number" && Number.isFinite(context.durationMs)) {
		return context.durationMs;
	}
	const state =
		context?.state && typeof context.state === "object"
			? (context.state as Record<string, unknown>)
			: undefined;
	if (!state) return undefined;
	const existing = state[STARTED_AT_STATE_KEY];
	if (typeof existing === "number" && Number.isFinite(existing)) {
		return Math.max(0, Date.now() - existing);
	}
	if (context?.executionStarted || context?.isPartial) {
		state[STARTED_AT_STATE_KEY] = Date.now();
		return 0;
	}
	return undefined;
}

function attachmentCountMeta(attachments: unknown): string | undefined {
	if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
	return `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`;
}

function formatIntercomArgs(args: IntercomCallArgs | undefined, fallbackTarget?: string): string {
	const action = typeof args?.action === "string" && args.action.trim() ? terminalSafeLabel(args.action.trim()) : "";
	const to =
		typeof args?.to === "string" && args.to.trim()
			? terminalSafeLabel(args.to.trim())
			: fallbackTarget
				? terminalSafeLabel(fallbackTarget)
				: undefined;
	const group = typeof args?.group === "string" && args.group.trim() ? terminalSafeLabel(args.group.trim()) : undefined;
	const askId = typeof args?.askId === "string" && args.askId.trim() ? terminalSafeLabel(args.askId.trim()) : undefined;
	if (action === "send" || action === "ask" || action === "reply") {
		return to ? `${action} → ${to}` : action;
	}
	if (action === "join" || action === "leave") {
		return group ? `${action} → ${group}` : action;
	}
	if (action === "cancel") {
		return askId ? `cancel · ${askId}` : "cancel";
	}
	return action;
}

function formatSupervisorArgs(args: SupervisorCallArgs | undefined): string {
	const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
	if (reason === "need_decision") return "need decision";
	if (reason === "progress_update") return "progress update";
	if (reason === "interview_request") return "interview";
	return reason ? terminalSafeLabel(reason.replaceAll("_", " ")) : "contact";
}

function createCollapsibleMarkdownComponent(
	heading: string | undefined,
	bodyText: string,
	expanded: boolean,
): Component {
	const markdown = new ToolBlockMarkdown(terminalSafeText(bodyText));
	return {
		invalidate(): void {
			markdown.invalidate();
		},
		render(width: number): string[] {
			const rendered = markdown.render(width);
			const bodyLines =
				expanded || rendered.length <= 4
					? rendered
					: collapseToolBlockLines(rendered, TOOL_BLOCK_LIMITS.inbound, false);
			return heading ? [heading, ...bodyLines] : bodyLines;
		},
	};
}

function extractRefusalReason(rawText: string, details: IntercomResultDetails | undefined): string {
	const prefixMatch = rawText.match(/^(?:Message|Reply) to "[^"]*" was not delivered:\s*([\s\S]+)$/);
	if (prefixMatch?.[1]) {
		return terminalSafeLabel(prefixMatch[1].trim());
	}
	if (typeof details?.reason === "string" && details.reason.trim()) {
		return terminalSafeLabel(details.reason.trim());
	}
	return terminalSafeLabel(rawText.trim() || "not delivered");
}

function formatPatternRecipientsSummary(recipients: readonly PatternRecipientOutcome[]): string {
	const queued = recipients.filter((recipient) => recipient.outcome === "queued").length;
	const delivered = recipients.filter((recipient) => recipient.outcome === "delivered").length;
	const refused = recipients.filter((recipient) => recipient.outcome === "refused").length;
	const unknown = recipients.filter((recipient) => recipient.outcome === "unknown").length;
	const parts: string[] = [];
	if (queued > 0) parts.push(`${parts.length === 0 ? "Queued" : "queued"} for ${queued}`);
	if (delivered > 0) parts.push(`${parts.length === 0 ? "Delivered" : "delivered"} to ${delivered}`);
	if (refused > 0) parts.push(`${parts.length === 0 ? "Refused" : "refused"} by ${refused}`);
	if (unknown > 0) parts.push(`${parts.length === 0 ? "Unknown" : "unknown"} for ${unknown}`);
	return parts.join(" · ") || "Delivered";
}

function formatListRecord(
	rawText: string,
	details: IntercomResultDetails | undefined,
	theme: Theme,
	expanded: boolean,
): Component | undefined {
	const lines = rawText.split("\n");
	const sessionEntries: { name: string; status: string; isSelf: boolean }[] = [];
	for (const line of lines) {
		const match = line.match(/^- `([^`]+)`(?:\s+\[([^\]]+)\])?/);
		if (!match) continue;
		const named = /\sname:\s+(\S+)$/.exec(line.slice(match[0].length));
		const id = match[1] ?? "";
		const tags = (match[2] ?? "")
			.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean);
		const name = terminalSafeLabel(named?.[1] ?? id.slice(0, 8));
		const isSelf = tags.includes("self");
		const status = tags.some((tag) => tag === "idle")
			? "idle"
			: tags.some((tag) => tag.startsWith("closed"))
				? "closed"
				: "busy";
		sessionEntries.push({ name, status, isSelf });
	}
	if (sessionEntries.length === 0) return undefined;
	const groupName = details?.peekGroup ?? details?.group ?? details?.groups?.at(-1);
	const count = sessionEntries.length;
	const summary = `${theme.bold(String(count))} session${count === 1 ? "" : "s"}${
		groupName ? ` in ${terminalSafeLabel(groupName)}` : ""
	}`;
	const peers = sessionEntries.filter((entry) => !entry.isSelf);
	const rows = (peers.length > 0 ? peers : sessionEntries).map(
		(entry) => `${entry.name} ${theme.fg("dim", `· ${entry.status}`)}`,
	);
	return {
		invalidate(): void {},
		render(): string[] {
			const visibleRows =
				expanded || rows.length <= 1 ? rows : collapseToolBlockLines(rows, 1, false);
			return [summary, ...visibleRows];
		},
	};
}

class RunningToolBlockComponent implements Component {
	readonly toolBlockKind = "block" as const;
	private readonly title: string;
	private readonly callArgs: string;
	private readonly extraMeta: readonly string[];
	private readonly waitingLabel?: string;
	private readonly context?: Partial<RenderContext>;

	constructor(options: {
		title: string;
		callArgs: string;
		extraMeta: readonly string[];
		waitingLabel?: string;
		context?: Partial<RenderContext>;
	}) {
		this.title = options.title;
		this.callArgs = options.callArgs;
		this.extraMeta = options.extraMeta;
		this.waitingLabel = options.waitingLabel;
		this.context = options.context;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const elapsed = formatElapsed(resolveRunningElapsedMs(this.context));
		const meta = [...(elapsed ? [elapsed] : []), ...this.extraMeta];
		const details =
			this.waitingLabel && (this.context?.executionStarted ?? true)
				? new ToolBlockRecords([`${this.waitingLabel}${elapsed ? ` · ${elapsed}` : ""}`])
				: undefined;
		return new ToolBlock({
			status: "running",
			title: this.title,
			args: this.callArgs || undefined,
			meta,
			details,
			outputPad: this.context?.outputPad ?? 1,
		}).render(width);
	}
}

export const renderIntercomCall: ToolCallRenderer = (args, _theme, context) => {
	const input = (args && typeof args === "object" ? args : {}) as IntercomCallArgs;
	const action = typeof input.action === "string" ? input.action.trim() : "";
	const callArgs = formatIntercomArgs(input);
	const attachmentMeta = attachmentCountMeta(input.attachments);
	const extraMeta = attachmentMeta ? [attachmentMeta] : [];
	return new RunningToolBlockComponent({
		title: "Intercom",
		callArgs,
		extraMeta,
		waitingLabel: action === "ask" ? "Waiting for reply" : undefined,
		context,
	});
};

export const renderContactSupervisorCall: ToolCallRenderer = (args, _theme, context) => {
	const input = (args && typeof args === "object" ? args : {}) as SupervisorCallArgs;
	const reason = typeof input.reason === "string" ? input.reason.trim() : "";
	const callArgs = formatSupervisorArgs(input);
	const waiting = reason !== "progress_update";
	return new RunningToolBlockComponent({
		title: "Supervisor",
		callArgs,
		extraMeta: [],
		waitingLabel: waiting ? "Waiting for supervisor" : undefined,
		context,
	});
};

export const renderIntercomResult: ToolResultRenderer = (result, { isPartial, expanded: optExpanded }, theme, context) => {
	const input = (context?.args && typeof context.args === "object" ? context.args : {}) as IntercomCallArgs;
	const action = typeof input.action === "string" ? input.action.trim() : "";
	const details = result.details as IntercomResultDetails | undefined;
	const expanded = Boolean(context?.expanded ?? optExpanded);
	const attachmentMeta = attachmentCountMeta(input.attachments);
	const rawText = firstRawTextContent(result);

	const inferredTarget =
		details?.target ??
		rawText.match(/^(?:Message|Reply) (?:sent to|queued for) ([^\n(]+)$/)?.[1]?.trim() ??
		rawText.match(/^(?:Message|Reply) to "([^"]+)"/)?.[1]?.trim();
	const callArgs = formatIntercomArgs(input, inferredTarget);

	if (isPartial) {
		return new RunningToolBlockComponent({
			title: "Intercom",
			callArgs,
			extraMeta: attachmentMeta ? [attachmentMeta] : [],
			waitingLabel: "Waiting for reply",
			context: { ...context, isPartial: true, executionStarted: true },
		});
	}

	const failed = Boolean(
		context?.isError || details?.error === true || (details?.delivered === false && details?.queued !== true),
	);
	const isRefusal =
		failed &&
		(details?.delivered === false ||
			typeof details?.reason === "string" ||
			/^(?:Message|Reply) to "|Cannot message|matches \d+ sessions|ask needs one exact target/i.test(rawText.trim()));

	const meta: string[] = [];
	if (failed) {
		meta.push(theme.fg("error", isRefusal ? "refused" : "failed"));
	}
	const elapsed = formatElapsed(context?.durationMs);
	if (elapsed) meta.push(elapsed);
	if (Array.isArray(details?.recipients) && details.recipients.length > 0) {
		meta.push(`${details.recipients.length} recipient${details.recipients.length === 1 ? "" : "s"}`);
	}
	if (attachmentMeta) meta.push(attachmentMeta);

	const records: (string | Component)[] = [];

	if (failed) {
		const errorDetail = isRefusal
			? `Refused · ${extractRefusalReason(rawText, details)}`
			: terminalSafeText(rawText.trim() || "Failed").replace(/^Failed:\s*/i, "");
		records.push(new Text(theme.fg("error", errorDetail), 0, 0));
	} else if (Array.isArray(details?.recipients) && details.recipients.length > 0) {
		const summary = formatPatternRecipientsSummary(details.recipients);
		if (expanded) {
			const recipientRows = details.recipients.map(
				(recipient) =>
					`${terminalSafeLabel(recipient.label)} · ${recipient.outcome}${
						recipient.reason ? ` · ${terminalSafeLabel(recipient.reason)}` : ""
					}`,
			);
			records.push(new Text([summary, ...recipientRows].map((line) => theme.fg("toolOutput", line)).join("\n"), 0, 0));
		} else {
			records.push(summary);
		}
	} else if (details?.pending === true) {
		records.push("Asked · reply will arrive as a message");
	} else if (details?.queued === true) {
		const queuedLines = terminalSafeText(rawText.trim())
			.replace(/^(?:Message|Reply) queued for /i, "Queued for ")
			.split("\n");
		records.push(
			queuedLines.length <= 1
				? (queuedLines[0] || `Queued for ${inferredTarget ?? "recipient"}`)
				: new Text(queuedLines.map((line) => theme.fg("toolOutput", line)).join("\n"), 0, 0),
		);
	} else if (details?.replied === true || /^\*\*Reply from ([^\n*]+):\*\*\n/i.test(rawText)) {
		const replyMatch = rawText.match(/^\*\*Reply from ([^\n*]+):\*\*\n([\s\S]*)$/i);
		const peer = terminalSafeLabel(replyMatch?.[1]?.trim() || inferredTarget || "peer");
		const replyBody = replyMatch?.[2] ?? rawText;
		records.push(createCollapsibleMarkdownComponent(theme.fg("toolOutput", `Reply from ${peer}`), replyBody, expanded));
	} else if (action === "list" || (Array.isArray(details?.groups) && rawText.includes("**Current session**"))) {
		const listComponent = formatListRecord(rawText, details, theme, expanded);
		if (listComponent) {
			records.push(listComponent);
		} else if (rawText.trim()) {
			records.push(createCollapsibleMarkdownComponent(undefined, rawText, expanded));
		}
	} else if (
		details?.delivered === true &&
		(/^(?:Message|Reply) sent to /i.test(rawText.trim()) || rawText.trim() === "" || rawText.trim() === "sent")
	) {
		records.push("Delivered");
	} else if (rawText.trim()) {
		records.push(createCollapsibleMarkdownComponent(undefined, rawText, expanded));
	} else if (details?.delivered === true) {
		records.push("Delivered");
	}

	if (expanded && typeof input.message === "string" && input.message.trim()) {
		records.push(createCollapsibleMarkdownComponent(theme.bold("Message"), input.message, true));
	}
	if (expanded && typeof details?.messageId === "string" && details.messageId.trim()) {
		records.push(`Message id ${terminalSafeLabel(details.messageId.trim())}`);
	}

	return new ToolBlock({
		status: failed ? "failure" : "success",
		title: "Intercom",
		args: callArgs || undefined,
		meta,
		details: records.length > 0 ? new ToolBlockRecords(records) : undefined,
		outputPad: context?.outputPad ?? 1,
	});
};

export const renderContactSupervisorResult: ToolResultRenderer = (
	result,
	{ isPartial, expanded: optExpanded },
	theme,
	context,
) => {
	const input = (context?.args && typeof context.args === "object" ? context.args : {}) as SupervisorCallArgs;
	const callArgs = formatSupervisorArgs(input);
	const details = result.details as ContactSupervisorResultDetails | undefined;
	const expanded = Boolean(context?.expanded ?? optExpanded);
	const rawText = firstRawTextContent(result);

	if (isPartial) {
		return new RunningToolBlockComponent({
			title: "Supervisor",
			callArgs,
			extraMeta: [],
			waitingLabel: "Waiting for supervisor",
			context: { ...context, isPartial: true, executionStarted: true },
		});
	}

	const failed = Boolean(
		context?.isError || details?.error === true || (details?.delivered === false && details?.queued !== true),
	);
	const isRefusal =
		failed && (details?.delivered === false || typeof details?.reason === "string" || /^Message to "/i.test(rawText));

	const meta: string[] = [];
	if (failed) {
		meta.push(theme.fg("error", isRefusal ? "refused" : "failed"));
	}
	const elapsed = formatElapsed(context?.durationMs);
	if (elapsed) meta.push(elapsed);

	const records: (string | Component)[] = [];
	if (failed) {
		const errorDetail = isRefusal
			? `Refused · ${extractRefusalReason(rawText, details)}`
			: terminalSafeText(rawText.trim() || "Failed").replace(/^Failed:\s*/i, "");
		records.push(new Text(theme.fg("error", errorDetail), 0, 0));
	} else if (details?.queued === true) {
		records.push("Queued for supervisor");
	} else if (
		details?.yielded === true ||
		(details?.delivered === true && /^Progress update sent to supervisor/i.test(rawText.trim()))
	) {
		records.push("Delivered");
	} else if (/^\*\*Reply from supervisor:\*\*\n/i.test(rawText)) {
		const replyBody = rawText.replace(/^\*\*Reply from supervisor:\*\*\n/i, "");
		records.push(
			createCollapsibleMarkdownComponent(theme.fg("toolOutput", "Reply from supervisor"), replyBody, expanded),
		);
	} else if (rawText.trim()) {
		records.push(
			createCollapsibleMarkdownComponent(theme.fg("toolOutput", "Reply from supervisor"), rawText, expanded),
		);
	} else {
		records.push("Delivered");
	}

	const parseError = details?.structuredReplyParseError;
	if (typeof parseError === "string" && parseError.trim()) {
		records.push(
			new Text(
				theme.fg("warning", `! Structured reply could not be parsed · ${terminalSafeLabel(parseError.trim())}`),
				0,
				0,
			),
		);
	}

	if (expanded && typeof input.message === "string" && input.message.trim()) {
		records.push(createCollapsibleMarkdownComponent(theme.bold("Message"), input.message, true));
	}

	return new ToolBlock({
		status: failed ? "failure" : "success",
		title: "Supervisor",
		args: callArgs || undefined,
		meta,
		details: records.length > 0 ? new ToolBlockRecords(records) : undefined,
		outputPad: context?.outputPad ?? 1,
	});
};

export function renderIntercomToolResult(name: string, args: ToolRenderResultArgs): ToolRenderResult {
	switch (name) {
		case "intercom":
			return renderIntercomResult(...args);
		case "contact_supervisor":
			return renderContactSupervisorResult(...args);
		default: {
			const theme = args[2];
			return new Text(theme.fg("error", `Result renderer not found: ${name}`), 0, 0);
		}
	}
}
