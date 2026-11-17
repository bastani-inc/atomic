import type { ChatMessageRenderOptions, ChatSessionHostStyle, ChatSessionViewportSettings } from "@bastani/atomic";
import { hexToAnsi, RESET } from "./color-utils.js";
import { editorRuleColor } from "./stage-chat-view-footer-status.js";
import { blankLine, cursorBlock, paint, workingIndicatorPalette } from "./stage-chat-view-render-helpers.js";
import type { StageChatViewContext, StageChatViewOpts } from "./stage-chat-view-types.js";

type StageChatRenderSettings = Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd">> & ChatSessionViewportSettings;

type MessageRendererHost = {
	extensionRunner?: {
		getMessageRenderer?: (
			customType: string,
		) => ReturnType<NonNullable<StageChatRenderSettings["getCustomMessageRenderer"]>>;
	};
};

export function stageChatRenderSettings(
	ctx: StageChatViewContext,
	opts: StageChatViewOpts,
): StageChatRenderSettings | undefined {
	const inherited = opts.getChatRenderSettings?.();
	const toolOutputExpanded = ctx.getToolsExpanded?.() ?? inherited?.toolOutputExpanded;
	const stageSession = ctx.handle?.isDisposed === true ? undefined : ctx.handle?.agentSession;
	if (!stageSession) {
		return toolOutputExpanded === undefined ? inherited : { ...inherited, toolOutputExpanded };
	}
	const rendererHost = stageSession as MessageRendererHost;
	return {
		...inherited,
		toolOutputExpanded,
		getToolDefinition: (toolName) =>
			stageSession.getToolDefinition(toolName) ?? inherited?.getToolDefinition?.(toolName),
		getCustomMessageRenderer: (customType) =>
			rendererHost.extensionRunner?.getMessageRenderer?.(customType) ??
			inherited?.getCustomMessageRenderer?.(customType),
	};
}

interface HostTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

function hostThemeOf(candidate: unknown): HostTheme | undefined {
	return typeof candidate === "object" &&
		candidate !== null &&
		typeof (candidate as { fg?: unknown }).fg === "function"
		? (candidate as HostTheme)
		: undefined;
}

export function chatHostStyle(ctx: StageChatViewContext): ChatSessionHostStyle {
	const hostTheme = hostThemeOf(ctx.piTheme);
	return {
		dim: (text) => (hostTheme ? hostTheme.fg("dim", text) : paint(text, ctx.theme.dim)),
		text: (text) => (hostTheme ? hostTheme.fg("text", text) : paint(text, ctx.theme.text)),
		textMuted: (text) => (hostTheme ? hostTheme.fg("muted", text) : paint(text, ctx.theme.textMuted)),
		accent: (text) => (hostTheme ? hostTheme.fg("accent", text) : paint(text, ctx.theme.accent)),
		accentBold: (text) =>
			hostTheme
				? typeof hostTheme.bold === "function"
					? hostTheme.bold(hostTheme.fg("accent", text))
					: hostTheme.fg("accent", text)
				: paint(text, ctx.theme.accent, { bold: true }),
		workingIndicatorPalette: ctx.piTheme === undefined ? () => workingIndicatorPalette(ctx.theme) : undefined,
		workingIndicatorUseGlobalTheme: ctx.piTheme !== undefined,
		rule: (hex, text) => hexToAnsi(hex) + text + RESET,
		cursor: () => cursorBlock(),
		blank: (width) => blankLine(width),
		editorRuleColor: (disabled, agentSession, state) => editorRuleColor(ctx, disabled, agentSession, state),
	};
}
