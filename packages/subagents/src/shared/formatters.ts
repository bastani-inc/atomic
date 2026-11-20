/**
 * Formatting utilities for display output
 */

import { formatModelReferenceLabel, formatTokenCount, sliceHead } from "@bastani/atomic";
import { THINKING_LEVELS } from "./model-info.js";
import type { Usage } from "./types.js";

/**
 * A subagent's model as every model label reads (#4269): its raw `provider/id`, then its level, which a known
 * `:level` suffix on `model` or else `thinking` gives.
 */
export function formatModelThinking(model?: string, thinking?: string): string {
	const explicitThinking = THINKING_LEVELS.find((level) => level === thinking?.trim());
	if (!model) return explicitThinking ? `thinking ${explicitThinking}` : "";
	return formatModelReferenceLabel(model, { thinkingLevel: explicitThinking });
}

/**
 * Format usage statistics into a compact string
 */
export function formatUsage(u: Usage): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`in:${formatTokenCount(u.input)}`);
	if (u.output) parts.push(`out:${formatTokenCount(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokenCount(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokenCount(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	return parts.join(" ");
}

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	return `${seconds}s`;
}

/**
 * Format a tool call for display
 */
export function formatToolCall(name: string, args: Record<string, unknown>, expanded = false): string {
	switch (name) {
		case "bash": {
			const command = typeof args.command === "string" ? args.command : "";
			const maxLength = expanded ? 240 : 60;
			return `$ ${sliceHead(command, maxLength)}${command.length > maxLength ? "..." : ""}`;
		}
		case "read":
		case "write":
		case "edit": {
			const target =
				typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
			return `${name} ${shortenPath(target)}`;
		}
		default: {
			const s = JSON.stringify(args);
			const maxLength = expanded ? 160 : 40;
			return `${name} ${sliceHead(s, maxLength)}${s.length > maxLength ? "..." : ""}`;
		}
	}
}

/**
 * Shorten a path by replacing home directory with ~
 */
export function shortenPath(p: string): string {
	const home = process.env.HOME;
	if (home && p.startsWith(home)) {
		return `~${p.slice(home.length)}`;
	}
	return p;
}
