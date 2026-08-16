import { formatModelThinking } from "../shared/formatters.js";
import type { Theme } from "./render-layout.js";

export function modelThinkingBadge(theme: Theme, model?: string, thinking?: string, fastMode?: boolean): string {
	const label = formatModelThinking(model, thinking, fastMode);
	return label ? theme.fg("dim", ` (${label})`) : "";
}
