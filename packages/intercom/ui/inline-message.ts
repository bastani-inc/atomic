import { homedir } from "node:os";
import type { Component } from "@bastani/atomic-tui";
import { Text, truncateToWidth } from "@bastani/atomic-tui";
import {
	collapseToolBlockLines,
	type MessageRenderer,
	type Theme,
	TOOL_BLOCK_LIMITS,
	ToolBlock,
	ToolBlockMarkdown,
	ToolBlockRecords,
} from "@bastani/atomic";
import { extractProjectedDisplayText, type InboundMessageEntry } from "../intercom-utils.js";
import type { Message, SessionInfo } from "../types.js";
import { terminalSafeLabel, terminalSafeText } from "./terminal-text.js";

export interface InlineMessageOptions {
	readonly expanded?: boolean;
	readonly outputPad?: number;
	readonly currentCwd?: string;
	readonly channel?: "supervisor";
	readonly receivedBeforeStart?: boolean;
	readonly heading?: string;
	readonly bodyText?: string;
	readonly replyCommand?: string;
}

function normalizePath(value: string): string {
	const trimmed = terminalSafeLabel(value).replace(/\\/g, "/").trim();
	if (trimmed === "/" || trimmed === "") return trimmed;
	return trimmed.replace(/\/+$/, "");
}

function formatCwdLabel(peerCwd: string, currentCwd?: string): string | undefined {
	const normalizedPeer = normalizePath(peerCwd);
	if (!normalizedPeer) return undefined;
	const normalizedCurrent = normalizePath(currentCwd ?? process.cwd());
	if (normalizedCurrent && normalizedPeer === normalizedCurrent) return undefined;
	const home = normalizePath(homedir());
	const tildeRelative =
		home && normalizedPeer === home
			? "~"
			: home && normalizedPeer.startsWith(`${home}/`)
				? `~/${normalizedPeer.slice(home.length + 1)}`
				: normalizedPeer;
	const segments = tildeRelative.split("/").filter(Boolean);
	if (segments.length === 0) return tildeRelative;
	return segments.length <= 2 ? segments.join("/") : segments.slice(-2).join("/");
}

function formatLocalSendTime(timestamp: number): string | undefined {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return undefined;
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${hours}:${minutes}`;
}

function singleLineRecord(text: string): Component {
	return {
		invalidate(): void {},
		render(width: number): string[] {
			return width < 1 ? [] : [truncateToWidth(text, width, "…")];
		},
	};
}
function formatAttachmentBytes(content: string): string {
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class InlineMessageComponent implements Component {
	private from: SessionInfo;
	private message: Message;
	private theme: Theme;
	private replyCommand?: string;
	private bodyText?: string;
	private heading?: string;
	private expanded: boolean;
	private outputPad: number;
	private currentCwd?: string;
	private channel?: "supervisor";
	private receivedBeforeStart: boolean;
	private markdown: ToolBlockMarkdown;

	constructor(
		from: SessionInfo,
		message: Message,
		theme: Theme,
		replyCommandOrOptions?: string | InlineMessageOptions,
		bodyText?: string,
		heading?: string,
		options?: InlineMessageOptions,
	) {
		this.from = from;
		this.message = message;
		this.theme = theme;
		const resolvedOptions =
			typeof replyCommandOrOptions === "object" && replyCommandOrOptions !== null ? replyCommandOrOptions : options;
		this.replyCommand =
			typeof replyCommandOrOptions === "string" ? replyCommandOrOptions : resolvedOptions?.replyCommand;
		this.bodyText = bodyText ?? resolvedOptions?.bodyText;
		this.heading = heading ?? resolvedOptions?.heading;
		this.expanded = resolvedOptions?.expanded ?? false;
		this.outputPad = resolvedOptions?.outputPad ?? 1;
		this.currentCwd = resolvedOptions?.currentCwd;
		this.channel = resolvedOptions?.channel;
		this.receivedBeforeStart = resolvedOptions?.receivedBeforeStart === true;
		this.markdown = new ToolBlockMarkdown(
			terminalSafeText(this.bodyText ?? extractProjectedDisplayText(this.message.content)),
		);
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		const rawName = this.from.name?.trim();
		const senderName = rawName ? terminalSafeLabel(rawName) : terminalSafeLabel(this.from.id).slice(0, 8);
		if (width < 3) {
			return [truncateToWidth(`From ${senderName}`, width)];
		}

		const deliveryFailed = Boolean(this.message.replyTo) && this.message.replyError !== undefined;
		const isReply = Boolean(this.message.replyTo) && !this.message.expectsReply && !deliveryFailed;
		const isSupervisorUpdate =
			!deliveryFailed && !isReply && this.channel === "supervisor" && this.message.expectsReply !== true;
		const sendTime = formatLocalSendTime(this.message.timestamp);
		const cwd = formatCwdLabel(this.from.cwd, this.currentCwd);

		const titleText = deliveryFailed
			? this.theme.fg("error", "Delivery failed")
			: this.heading !== undefined
				? this.theme.fg("muted", terminalSafeLabel(this.heading))
				: isReply
					? `${this.theme.fg("muted", "Reply from")} ${this.theme.fg("accent", this.theme.bold(senderName))}`
					: `${this.theme.fg("muted", "Message from")} ${this.theme.fg("accent", this.theme.bold(senderName))}`;

		const meta: string[] = [];
		if (deliveryFailed) {
			meta.push(`to ${senderName}`);
			if (sendTime) meta.push(sendTime);
		} else {
			if (cwd) meta.push(cwd);
			if (isSupervisorUpdate) {
				meta.push(sendTime ? `update sent ${sendTime}` : "update");
			} else {
				if (sendTime) meta.push(sendTime);
				if (this.receivedBeforeStart) {
					meta.push("sent before you started");
				} else if (this.message.expectsReply) {
					meta.push(this.theme.fg("warning", "asks for a reply"));
				}
			}
		}

		if (width < 20) {
			return new ToolBlock({
				status: deliveryFailed ? "failure" : "info",
				title: new Text(titleText, 0, 0),
				meta,
				outputPad: this.outputPad,
			}).render(width);
		}

		const bodyComponent: Component = {
			invalidate: () => this.markdown.invalidate(),
			render: (bodyWidth: number) => {
				const rendered = this.markdown.render(bodyWidth);
				if (this.expanded || rendered.length <= 4) return rendered;
				return collapseToolBlockLines(rendered, TOOL_BLOCK_LIMITS.inbound, false);
			},
		};

		const records: (string | Component)[] = [];
		if (this.message.content.attachments?.length) {
			for (const att of this.message.content.attachments) {
				records.push(
					singleLineRecord(
						this.theme.fg(
							"toolOutput",
							`Attachment · ${terminalSafeLabel(att.name)} · ${formatAttachmentBytes(att.content)}`,
						),
					),
				);
			}
		}
		if (!deliveryFailed && (this.message.expectsReply || this.replyCommand)) {
			records.push(singleLineRecord(this.theme.fg("dim", "Reply with intercom reply")));
		}

		return new ToolBlock({
			status: deliveryFailed ? "failure" : "info",
			title: new Text(titleText, 0, 0),
			meta,
			body: bodyComponent,
			details: records.length > 0 ? new ToolBlockRecords(records) : undefined,
			outputPad: this.outputPad,
		}).render(width);
	}
}

export const renderIntercomCustomMessage: MessageRenderer = (message, options, theme) => {
	const details = message.details as Partial<InboundMessageEntry> | undefined;
	if (!details?.from || !details.message) return undefined;
	const isReplyOrFailure = Boolean(details.message.replyTo);
	return new InlineMessageComponent(details.from, details.message, theme, {
		expanded: options.expanded,
		outputPad: options.outputPad,
		channel: details.channel,
		receivedBeforeStart: details.receivedBeforeStart,
		heading: isReplyOrFailure ? undefined : details.heading,
		replyCommand: details.replyCommand,
	});
};
