import { DEFAULT_WORKING_MESSAGE } from "../../packages/coding-agent/src/modes/interactive/components/atomic-working-status.ts";
import { WHIMSICAL_WORKING_MESSAGES } from "../../packages/coding-agent/src/modes/interactive/whimsical-messages.ts";

const alternatives = [DEFAULT_WORKING_MESSAGE, ...WHIMSICAL_WORKING_MESSAGES]
	.map((message) => message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
	.join("|");

export const WORKING_MESSAGE = new RegExp(`(?<![\\p{L}-])(?:${alternatives})`, "u");
export const WORKING_LINE = new RegExp(`∀ (?:${alternatives})`, "u");
export const BARE_WORKING_LINE = new RegExp(`^ ∀ (?:${alternatives})$`, "u");
export const WORKED_LINE = /∀ \S+ for \d+(?:h|m|s)/u;
