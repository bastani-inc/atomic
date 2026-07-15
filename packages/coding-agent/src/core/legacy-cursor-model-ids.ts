/**
 * Rejection-only tombstones copied from the removed direct static Cursor catalog.
 * They never map to a replacement and never make a route executable.
 */
export const LEGACY_CURSOR_DIRECT_MODEL_IDS = [
	"claude-4-sonnet",
	"claude-4-sonnet-1m",
	"claude-4-sonnet-1m-thinking",
	"claude-4-sonnet-thinking",
	"claude-4.5-opus-high",
	"claude-4.5-opus-high-thinking",
	"claude-4.5-sonnet",
	"claude-4.5-sonnet-thinking",
	"claude-4.6-opus-high",
	"claude-4.6-opus-high-thinking",
	"claude-4.6-opus-max",
	"claude-4.6-opus-max-thinking",
	"claude-4.6-sonnet-medium",
	"claude-4.6-sonnet-medium-thinking",
	"composer-1.5",
	"composer-2",
	"composer-2-fast",
	"default",
	"gemini-3-flash",
	"gemini-3.1-pro",
	"gpt-5-mini",
	"gpt-5.1",
	"gpt-5.1-codex-max-high",
	"gpt-5.1-codex-max-high-fast",
	"gpt-5.1-codex-max-low",
	"gpt-5.1-codex-max-low-fast",
	"gpt-5.1-codex-max-medium",
	"gpt-5.1-codex-max-medium-fast",
	"gpt-5.1-codex-max-xhigh",
	"gpt-5.1-codex-max-xhigh-fast",
	"gpt-5.1-codex-mini",
	"gpt-5.1-codex-mini-high",
	"gpt-5.1-codex-mini-low",
	"gpt-5.1-high",
	"gpt-5.1-low",
	"gpt-5.2",
	"gpt-5.2-codex",
	"gpt-5.2-codex-fast",
	"gpt-5.2-codex-high",
	"gpt-5.2-codex-high-fast",
	"gpt-5.2-codex-low",
	"gpt-5.2-codex-low-fast",
	"gpt-5.2-codex-xhigh",
	"gpt-5.2-codex-xhigh-fast",
	"gpt-5.2-fast",
	"gpt-5.2-high",
	"gpt-5.2-high-fast",
	"gpt-5.2-low",
	"gpt-5.2-low-fast",
	"gpt-5.2-xhigh",
	"gpt-5.2-xhigh-fast",
	"gpt-5.3-codex",
	"gpt-5.3-codex-fast",
	"gpt-5.3-codex-high",
	"gpt-5.3-codex-high-fast",
	"gpt-5.3-codex-low",
	"gpt-5.3-codex-low-fast",
	"gpt-5.3-codex-spark-preview",
	"gpt-5.3-codex-spark-preview-high",
	"gpt-5.3-codex-spark-preview-low",
	"gpt-5.3-codex-spark-preview-xhigh",
	"gpt-5.3-codex-xhigh",
	"gpt-5.3-codex-xhigh-fast",
	"gpt-5.4-high",
	"gpt-5.4-high-fast",
	"gpt-5.4-low",
	"gpt-5.4-medium",
	"gpt-5.4-medium-fast",
	"gpt-5.4-mini-high",
	"gpt-5.4-mini-low",
	"gpt-5.4-mini-medium",
	"gpt-5.4-mini-none",
	"gpt-5.4-mini-xhigh",
	"gpt-5.4-nano-high",
	"gpt-5.4-nano-low",
	"gpt-5.4-nano-medium",
	"gpt-5.4-nano-none",
	"gpt-5.4-nano-xhigh",
	"gpt-5.4-xhigh",
	"gpt-5.4-xhigh-fast",
	"gpt-5.5",
	"grok-4.3",
	"kimi-k2.5",
] as const;

const LEGACY_CURSOR_DIRECT_MODEL_ID_SET: ReadonlySet<string> = new Set(LEGACY_CURSOR_DIRECT_MODEL_IDS);

export type BareCursorModelReferenceKind = "current-cursor" | "legacy-cursor" | "other";
export interface CursorModelIdentity {
	readonly provider: string;
	readonly id: string;
}

export function classifyBareCursorModelReference(
	rawInput: string,
	models: readonly CursorModelIdentity[],
): BareCursorModelReferenceKind {
	if (rawInput.includes("/")) return "other";
	if (models.some((model) => model.provider.toLowerCase() === "cursor" && model.id === rawInput)) {
		return "current-cursor";
	}
	return LEGACY_CURSOR_DIRECT_MODEL_ID_SET.has(rawInput) ? "legacy-cursor" : "other";
}

export function isLegacyBareCursorModelId(rawInput: string): boolean {
	return !rawInput.includes("/") && LEGACY_CURSOR_DIRECT_MODEL_ID_SET.has(rawInput);
}
