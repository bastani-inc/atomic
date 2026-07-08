import type { ToolDefinition } from "@bastani/atomic";
import { Text } from "@earendil-works/pi-tui";

type ToolResultRenderer = NonNullable<ToolDefinition["renderResult"]>;
type ToolRenderResultArgs = Parameters<ToolResultRenderer>;
type ToolRenderResult = ReturnType<ToolResultRenderer>;
type RenderedResult = ToolRenderResultArgs[0];
type TextContentBlock = Extract<RenderedResult["content"][number], { type: "text" }>;

type IntercomResultDetails = {
	delivered?: boolean;
	error?: boolean;
	messageId?: string;
	reason?: string;
};

type ContactSupervisorResultDetails = IntercomResultDetails & {
	structuredReplyParseError?: string;
};

function isTextContentBlock(block: RenderedResult["content"][number]): block is TextContentBlock {
	return block.type === "text";
}

function firstTextContent(result: RenderedResult): string {
	return result.content.find(isTextContentBlock)?.text.replace(/\*\*/g, "") ?? "";
}

export const renderContactSupervisorResult: ToolResultRenderer = (result, { isPartial }, theme, context) => {
	if (isPartial) {
		return new Text(theme.fg("warning", "Waiting for supervisor..."), 0, 0);
	}
	const details = result.details as ContactSupervisorResultDetails | undefined;
	const textContent = firstTextContent(result);
	const failed = Boolean(context.isError || details?.error === true || details?.delivered === false);
	const parseWarning = typeof details?.structuredReplyParseError === "string";
	let text = failed
		? theme.fg("error", "✗ ")
		: parseWarning
			? theme.fg("warning", "⚠ ")
			: theme.fg("success", "✓ ");
	text += theme.fg(failed ? "error" : "text", textContent);
	if (parseWarning) {
		text += "\n" + theme.fg("warning", `Structured reply parse issue: ${details.structuredReplyParseError}`);
	}
	return new Text(text, 0, 0);
};

export const renderIntercomResult: ToolResultRenderer = (result, { isPartial }, theme, context) => {
	if (isPartial) {
		return new Text(theme.fg("warning", "Intercom working..."), 0, 0);
	}
	const details = result.details as IntercomResultDetails | undefined;
	const failed = Boolean(context.isError || details?.error === true || details?.delivered === false);
	let text = failed ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
	text += theme.fg(failed ? "error" : "text", firstTextContent(result));
	if (details?.messageId && !context.expanded) {
		text += theme.fg("dim", ` (${details.messageId.slice(0, 8)})`);
	}
	if (details?.reason && context.expanded) {
		text += "\n" + theme.fg("dim", `Reason: ${details.reason}`);
	}
	return new Text(text, 0, 0);
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
