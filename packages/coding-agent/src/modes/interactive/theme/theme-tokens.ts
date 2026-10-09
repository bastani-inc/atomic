export interface ThemeTokenDescriptor {
	slot: "foreground" | "background";
	description: string;
	/** Token in the same slot that supplies this token's color when a theme omits it. */
	fallback?: string;
}

export type ThemeTokenDescriptors = Readonly<Record<string, ThemeTokenDescriptor>>;

function defineThemeTokens<const T extends ThemeTokenDescriptors>(tokens: T): T {
	for (const [name, descriptor] of Object.entries(tokens)) {
		if (descriptor.fallback === undefined) continue;
		const fallback = tokens[descriptor.fallback];
		if (fallback === undefined) {
			throw new Error(`Theme token ${name} has unknown fallback ${descriptor.fallback}`);
		}
		if (fallback.slot !== descriptor.slot) {
			throw new Error(`Theme token ${name} has fallback ${descriptor.fallback} in a different color slot`);
		}
	}
	return tokens;
}

/**
 * Theme token metadata in the same order used by theme files and the published JSON Schema.
 * A token with a `fallback` is optional: a theme written before the token existed keeps validating and
 * keeps rendering with the fallback token's color.
 */
export const THEME_TOKENS = defineThemeTokens({
	accent: { slot: "foreground", description: "Primary accent color (logo, selected items, cursor)" },
	border: { slot: "foreground", description: "Normal borders" },
	borderAccent: { slot: "foreground", description: "Highlighted borders" },
	borderMuted: { slot: "foreground", description: "Subtle borders" },
	success: { slot: "foreground", description: "Success states" },
	error: { slot: "foreground", description: "Error states" },
	warning: { slot: "foreground", description: "Warning states" },
	muted: { slot: "foreground", description: "Secondary/dimmed text" },
	dim: { slot: "foreground", description: "Very dimmed text (more subtle than muted)" },
	text: { slot: "foreground", description: "Default text color (usually empty string)" },
	thinkingText: { slot: "foreground", description: "Thinking block text color" },
	selectedBg: { slot: "background", description: "Selected item background" },
	scrollbarThumb: {
		slot: "background",
		description: "Fullscreen scrollbar thumb background (falls back to selectedBg when omitted)",
		fallback: "selectedBg",
	},
	searchMatchBg: {
		slot: "background",
		description: "Transcript search match background and current-match text (falls back to selectedBg when omitted)",
		fallback: "selectedBg",
	},
	searchMatchText: {
		slot: "foreground",
		description: "Transcript search match text and current-match background (falls back to text when omitted)",
		fallback: "text",
	},
	userMessageBg: { slot: "background", description: "User message background" },
	userMessageText: { slot: "foreground", description: "User message text color" },
	customMessageBg: { slot: "background", description: "Custom message background (hook-injected messages)" },
	customMessageText: { slot: "foreground", description: "Custom message text color" },
	customMessageLabel: { slot: "foreground", description: "Custom message type label color" },
	toolPendingBg: { slot: "background", description: "Tool execution box (pending state)" },
	toolSuccessBg: { slot: "background", description: "Tool execution box (success state)" },
	toolErrorBg: { slot: "background", description: "Tool execution box (error state)" },
	toolTitle: { slot: "foreground", description: "Tool execution box title color" },
	toolOutput: { slot: "foreground", description: "Tool execution box output text color" },
	mdHeading: { slot: "foreground", description: "Markdown heading text" },
	mdLink: { slot: "foreground", description: "Markdown link text" },
	mdLinkUrl: { slot: "foreground", description: "Markdown link URL" },
	mdCode: { slot: "foreground", description: "Markdown inline code" },
	mdCodeBlock: { slot: "foreground", description: "Markdown code block content" },
	mdCodeBlockBorder: { slot: "foreground", description: "Markdown code block fences" },
	mdQuote: { slot: "foreground", description: "Markdown blockquote text" },
	mdQuoteBorder: { slot: "foreground", description: "Markdown blockquote border" },
	mdHr: { slot: "foreground", description: "Markdown horizontal rule" },
	mdListBullet: { slot: "foreground", description: "Markdown list bullets/numbers" },
	toolDiffAdded: { slot: "foreground", description: "Added lines in tool diffs" },
	toolDiffRemoved: { slot: "foreground", description: "Removed lines in tool diffs" },
	toolDiffContext: { slot: "foreground", description: "Context lines in tool diffs" },
	syntaxComment: { slot: "foreground", description: "Syntax highlighting: comments" },
	syntaxKeyword: { slot: "foreground", description: "Syntax highlighting: keywords" },
	syntaxFunction: { slot: "foreground", description: "Syntax highlighting: function names" },
	syntaxVariable: { slot: "foreground", description: "Syntax highlighting: variable names" },
	syntaxString: { slot: "foreground", description: "Syntax highlighting: string literals" },
	syntaxNumber: { slot: "foreground", description: "Syntax highlighting: number literals" },
	syntaxType: { slot: "foreground", description: "Syntax highlighting: type names" },
	syntaxOperator: { slot: "foreground", description: "Syntax highlighting: operators" },
	syntaxPunctuation: { slot: "foreground", description: "Syntax highlighting: punctuation" },
	thinkingOff: { slot: "foreground", description: "Thinking level border: off" },
	thinkingMinimal: { slot: "foreground", description: "Thinking level border: minimal" },
	thinkingLow: { slot: "foreground", description: "Thinking level border: low" },
	thinkingMedium: { slot: "foreground", description: "Thinking level border: medium" },
	thinkingHigh: { slot: "foreground", description: "Thinking level border: high" },
	thinkingXhigh: { slot: "foreground", description: "Thinking level border: xhigh (OpenAI codex-max only)" },
	bashMode: { slot: "foreground", description: "Editor border color in bash mode" },
});

export type ThemeToken = keyof typeof THEME_TOKENS;
export type ThemeColor = {
	[K in ThemeToken]: (typeof THEME_TOKENS)[K]["slot"] extends "foreground" ? K : never;
}[ThemeToken];
export type ThemeBg = Exclude<ThemeToken, ThemeColor>;

type OptionalToken = {
	[K in ThemeToken]: (typeof THEME_TOKENS)[K] extends { fallback: string } ? K : never;
}[ThemeToken];

type RequiredToken = Exclude<ThemeToken, OptionalToken>;

export type ThemeColorValues<Value> = {
	[K in RequiredToken]: Value;
} & {
	[K in OptionalToken]?: Value;
};

export type ResolvedThemeColorValues<Value> = Record<ThemeToken, Value>;

/** Fill omitted optional tokens from their fallback tokens. */
export function withThemeTokenFallbacks<Value>(values: ThemeColorValues<Value>): ResolvedThemeColorValues<Value> {
	const resolved = { ...values } as Partial<ResolvedThemeColorValues<Value>>;
	for (const [rawName, descriptor] of Object.entries(THEME_TOKENS)) {
		if (!("fallback" in descriptor)) continue;
		const name = rawName as ThemeToken;
		if (resolved[name] !== undefined) continue;
		const fallback = descriptor.fallback as ThemeToken;
		const fallbackValue = resolved[fallback];
		if (fallbackValue === undefined) {
			throw new Error(`Theme token ${rawName} has unresolved fallback ${descriptor.fallback}`);
		}
		resolved[name] = fallbackValue;
	}
	return resolved as ResolvedThemeColorValues<Value>;
}

/**
 * Split resolved token values into the foreground and background slots. Generated system themes also carry
 * palette entries that theme files cannot set; those are not tokens and are left out.
 */
export function splitThemeColors(colors: ResolvedThemeColorValues<string | number>): {
	fgColors: Record<ThemeColor, string | number>;
	bgColors: Record<ThemeBg, string | number>;
} {
	const fgColors = {} as Record<ThemeColor, string | number>;
	const bgColors = {} as Record<ThemeBg, string | number>;
	for (const [key, value] of Object.entries(colors)) {
		const token: ThemeTokenDescriptor | undefined = THEME_TOKENS[key as ThemeToken];
		if (token === undefined) continue;
		if (token.slot === "background") {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	return { fgColors, bgColors };
}
