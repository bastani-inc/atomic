import type { ExtensionContext } from "@bastani/atomic";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { activityMonitor, type ActivityEntry } from "./activity.js";

export interface ActivityWidgetState {
	visible: boolean;
	unsubscribe: (() => void) | null;
}

export function createActivityWidgetState(): ActivityWidgetState {
	return { visible: false, unsubscribe: null };
}

function updateWidget(ctx: ExtensionContext): void {
	const theme = ctx.ui.theme;
	const entries = activityMonitor.getEntries();
	const lines: string[] = [];

	lines.push(theme.fg("accent", "─── Web Search Activity " + "─".repeat(36)));

	if (entries.length === 0) {
		lines.push(theme.fg("muted", "  No activity yet"));
	} else {
		for (const e of entries) {
			lines.push("  " + formatEntryLine(e, theme));
		}
	}

	lines.push(theme.fg("accent", "─".repeat(60)));

	const rateInfo = activityMonitor.getRateLimitInfo();
	const resetMs = rateInfo.oldestTimestamp ? Math.max(0, rateInfo.oldestTimestamp + rateInfo.windowMs - Date.now()) : 0;
	const resetSec = Math.ceil(resetMs / 1000);
	lines.push(
		theme.fg("muted", `Rate: ${rateInfo.used}/${rateInfo.max}`) +
			(resetMs > 0 ? theme.fg("dim", ` (resets in ${resetSec}s)`) : ""),
	);

	ctx.ui.setWidget("web-activity", new Text(lines.join("\n"), 0, 0));
}

function formatEntryLine(
	entry: ActivityEntry,
	theme: { fg: (color: string, text: string) => string },
): string {
	const typeStr = entry.type === "api" ? "API" : "GET";
	const target =
		entry.type === "api"
			? `"${truncateToWidth(entry.query || "", 28, "")}"`
			: truncateToWidth(entry.url?.replace(/^https?:\/\//, "") || "", 30, "");

	const duration = entry.endTime
		? `${((entry.endTime - entry.startTime) / 1000).toFixed(1)}s`
		: `${((Date.now() - entry.startTime) / 1000).toFixed(1)}s`;

	let statusStr: string;
	let indicator: string;
	if (entry.error) {
		statusStr = "err";
		indicator = theme.fg("error", "✗");
	} else if (entry.status === null) {
		statusStr = "...";
		indicator = theme.fg("warning", "⋯");
	} else if (entry.status === 0) {
		statusStr = "abort";
		indicator = theme.fg("muted", "○");
	} else {
		statusStr = String(entry.status);
		indicator = entry.status >= 200 && entry.status < 300 ? theme.fg("success", "✓") : theme.fg("error", "✗");
	}

	return `${typeStr.padEnd(4)} ${target.padEnd(32)} ${statusStr.padStart(5)} ${duration.padStart(5)} ${indicator}`;
}

export function toggleActivityWidget(state: ActivityWidgetState, ctx: ExtensionContext): void {
	state.visible = !state.visible;
	if (state.visible) {
		state.unsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
		updateWidget(ctx);
	} else {
		state.unsubscribe?.();
		state.unsubscribe = null;
		ctx.ui.setWidget("web-activity", null);
	}
}

export function refreshActivityForSession(state: ActivityWidgetState, ctx: ExtensionContext): void {
	state.unsubscribe?.();
	state.unsubscribe = null;
	activityMonitor.clear();
	if (state.visible) {
		state.unsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
		updateWidget(ctx);
	}
}

export function shutdownActivityWidget(state: ActivityWidgetState): void {
	state.unsubscribe?.();
	state.unsubscribe = null;
	activityMonitor.clear();
	state.visible = false;
}
