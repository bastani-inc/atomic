import type { ThinkingLevel } from "@bastani/atomic-agent-core";

/**
 * Every thinking level a model reference may name as a `:<level>` suffix. A leaf module, so model resolution can use it
 * without loading the CLI argument parser.
 */
export const VALID_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return (VALID_THINKING_LEVELS as readonly string[]).includes(level);
}
