import { formatModelThinking } from "../shared/formatters.ts";
import type { Theme } from "./render-layout.ts";

export function modelThinkingBadge(theme: Theme, model?: string, thinking?: string, fastMode?: boolean): string {
	const label = formatModelThinking(model, thinking, fastMode);
	return label ? theme.fg("dim", ` (${label})`) : "";
}
