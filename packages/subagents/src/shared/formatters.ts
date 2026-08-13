/**
 * Formatting utilities for display output
 */

import { splitKnownThinkingSuffix, THINKING_LEVELS } from "./model-info.ts";
import type { Usage } from "./types.ts";

/**
 * Format token count with k suffix for large numbers
 */
export function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

export function formatModelThinking(model?: string, thinking?: string, fastMode?: boolean): string {
	const parsed = model ? splitKnownThinkingSuffix(model) : undefined;
	// Keep the full `provider/model` id so subagent lines read exactly like the
	// main chat's model display; only a known thinking suffix is split off.
	const displayModel = parsed?.baseModel ?? model;
	const explicitThinking = THINKING_LEVELS.find((level) => level === thinking?.trim());
	const displayThinking = parsed?.thinkingSuffix ? parsed.thinkingSuffix.slice(1) : explicitThinking;
	const parts = [displayModel, displayThinking ? `thinking ${displayThinking}` : undefined].filter(Boolean);
	if (fastMode && parts.length > 0) parts.push("fast");
	return parts.join(" · ");
}

/**
 * Format usage statistics into a compact string
 */
export function formatUsage(u: Usage): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`in:${formatTokens(u.input)}`);
	if (u.output) parts.push(`out:${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
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
			return `$ ${command.slice(0, maxLength)}${command.length > maxLength ? "..." : ""}`;
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
			return `${name} ${s.slice(0, maxLength)}${s.length > maxLength ? "..." : ""}`;
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
