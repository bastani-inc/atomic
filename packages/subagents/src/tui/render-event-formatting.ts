import { formatModelThinking } from "../shared/formatters.js";
import type { Theme } from "./render-layout.js";

export function modelThinkingBadge(theme: Theme, model?: string, thinking?: string): string {
	const label = formatModelThinking(model, thinking);
	return label ? theme.fg("dim", ` (${label})`) : "";
}
