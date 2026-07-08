import type { ExtensionContext } from "@bastani/atomic";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import * as path from "node:path";
import { MAX_WIDGET_JOBS, WIDGET_KEY, type AsyncJobState } from "../shared/types.ts";
import { getTermWidth, runningPulseGlyph, truncLine, type Theme } from "./render-layout.ts";
import { themeBold } from "./render-status-progress.ts";
import { advanceResultPulseFrame } from "./render-result-animation.ts";
import { widgetRenderKey } from "./render-stable-output.ts";
import {
	buildSingleWidgetLines,
	compactSingleWidgetLines,
	fitWidgetLineBudget,
	widgetParallelAgentDetails,
} from "./render-widget-graph.ts";
import {
	widgetActivity,
	widgetJobName,
	widgetStats,
	widgetStatusGlyph,
} from "./render-event-formatting.ts";

class LiveWidgetComponent implements Component {
	private readonly container = new Container();

	constructor(
		private readonly getJobs: () => AsyncJobState[],
		private readonly theme: Theme,
		private readonly getExpanded: () => boolean,
		private readonly getNow: () => number,
		private readonly getPulseFrame: () => number | undefined,
	) {}

	render(width: number): string[] {
		const jobs = this.getJobs();
		const expanded = this.getExpanded();
		const now = this.getNow();
		const pulseFrame = this.getPulseFrame();
		const lines = this.buildLines(jobs, width, expanded, now, pulseFrame);
		this.container.clear();
		for (const line of fitWidgetLineBudget(lines, this.theme, width, expanded)) this.container.addChild(new Text(line, 1, 0));
		return this.container.render(width);
	}

	private buildLines(jobs: AsyncJobState[], width: number, expanded: boolean, now: number, pulseFrame: number | undefined): string[] {
		if (expanded) return buildWidgetLines(jobs, this.theme, width, true, now, pulseFrame);
		if (jobs.length === 1) return compactSingleWidgetLines(jobs[0]!, this.theme, width, now, pulseFrame);
		return buildWidgetLines(jobs, this.theme, width, false, now, pulseFrame);
	}

	invalidate(): void {
		this.container.invalidate();
	}
}

function buildWidgetComponent(getJobs: () => AsyncJobState[], getExpanded: () => boolean, getNow: () => number, getPulseFrame: () => number | undefined): (_tui: unknown, theme: Theme) => Component {
	return (_tui, theme) => new LiveWidgetComponent(getJobs, theme, getExpanded, getNow, getPulseFrame);
}

interface RenderRequestingContext {
	ui: ExtensionContext["ui"] & { requestRender?: () => void };
}

// There is only ever one async-agents widget per host process, so the mounted
// component reads its driving context/jobs/pulse frame from module-level
// singletons instead of remounting the widget for every visible update.
let latestWidgetCtx: ExtensionContext | undefined;
let latestWidgetJobs: AsyncJobState[] = [];
let latestWidgetFrameNow = 0;
let latestWidgetExpanded = false;
let latestWidgetSnapshotKey: string | undefined;
let latestWidgetPulseFrame: number | undefined;
let mountedWidgetCtx: ExtensionContext | undefined;
let mountedWidgetOwnerKey: string | undefined;
let widgetMounted = false;

function getLatestWidgetJobs(): AsyncJobState[] {
	return latestWidgetJobs;
}

function getLatestWidgetFrameNow(): number {
	return latestWidgetFrameNow;
}

function getLatestWidgetPulseFrame(): number | undefined {
	return latestWidgetPulseFrame;
}

function getLatestWidgetExpanded(): boolean {
	// LiveWidgetComponent re-renders outside a specific renderWidget() call, so
	// remember the last expansion state observed from a live host UI. Workflow
	// stage-node detach can briefly repaint the mounted singleton with a stale or
	// no-UI context before the next subagent status update refreshes it; falling
	// back to the cached value avoids a transient collapse while jobs keep running.
	if (!latestWidgetCtx?.hasUI) return latestWidgetExpanded;
	const expanded = latestWidgetCtx.ui.getToolsExpanded?.();
	if (typeof expanded === "boolean") latestWidgetExpanded = expanded;
	return latestWidgetExpanded;
}

function clearLatestWidgetState(): void {
	latestWidgetCtx = undefined;
	latestWidgetJobs = [];
	latestWidgetFrameNow = 0;
	latestWidgetExpanded = false;
	latestWidgetSnapshotKey = undefined;
	latestWidgetPulseFrame = undefined;
	mountedWidgetCtx = undefined;
	mountedWidgetOwnerKey = undefined;
	widgetMounted = false;
}

function getWidgetOwnerKey(ctx: ExtensionContext): string {
	const resolvedCwd = ctx.cwd ? path.resolve(ctx.cwd) : undefined;
	const cwdOwner = resolvedCwd ?? "cwd:unknown";
	let sessionOwner = "session:unknown";
	try {
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		if (sessionFile) {
			const resolvedSessionFile = resolvedCwd
				? path.resolve(resolvedCwd, sessionFile)
				: path.resolve(sessionFile);
			sessionOwner = `sessionFile:${resolvedSessionFile}`;
		}
	} catch {
		// Fall through to the session id fallback below.
	}
	if (sessionOwner === "session:unknown") {
		try {
			const sessionId = ctx.sessionManager.getSessionId?.();
			if (sessionId) sessionOwner = `sessionId:${sessionId}`;
		} catch {
			// Keep the unknown marker; cwd still scopes ownership.
		}
	}
	// If no session identifier is available, cwd is the best available owner
	// boundary and may intentionally coalesce concurrent sessions in one folder.
	return `${sessionOwner}|cwd:${cwdOwner}`;
}

function widgetStatusText(jobs: AsyncJobState[]): string | undefined {
	if (jobs.length === 0) return undefined;
	const counts = new Map<string, number>();
	for (const job of jobs) counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
	const ordered = ["running", "queued", "complete", "failed", "paused"];
	const parts = ordered
		.map((status) => {
			const count = counts.get(status) ?? 0;
			return count > 0 ? `${count} ${status}` : undefined;
		})
		.filter((part): part is string => part !== undefined);
	return `Async agents: ${parts.join(", ")}`;
}

function setWidgetStatus(ctx: ExtensionContext, jobs: AsyncJobState[]): void {
	try {
		ctx.ui.setStatus?.(WIDGET_KEY, widgetStatusText(jobs));
	} catch {
		// Status mirroring must never prevent the primary widget render path.
	}
}

function requestWidgetRender(ctx: ExtensionContext): void {
	(ctx as RenderRequestingContext).ui.requestRender?.();
}

function unmountWidgetBestEffort(ctx: ExtensionContext | undefined): void {
	if (!ctx?.hasUI) return;
	try {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	} catch {
		// Best-effort teardown only: stale host contexts can reject cleanup during
		// reload/session rebinding, but local state still needs to move on so the
		// next status update can mount cleanly on the active UI context.
	}
	try {
		ctx.ui.setStatus?.(WIDGET_KEY, undefined);
	} catch {
		// Status mirroring cleanup must never block primary widget teardown.
	}
}

function widgetSnapshotKey(jobs: AsyncJobState[]): string {
	return jobs.map(widgetRenderKey).join("\n");
}

function refreshWidgetSnapshot(jobs: AsyncJobState[]): void {
	const snapshotKey = widgetSnapshotKey(jobs);
	if (snapshotKey === latestWidgetSnapshotKey) return;
	latestWidgetSnapshotKey = snapshotKey;
	latestWidgetFrameNow = Date.now();
	latestWidgetPulseFrame = advanceResultPulseFrame(latestWidgetPulseFrame);
}

// Full teardown: clear the mounted widget if possible, and forget the driving
// context/jobs entirely.
export function stopWidgetAnimation(): void {
	if (widgetMounted) unmountWidgetBestEffort(mountedWidgetCtx);
	clearLatestWidgetState();
}

export function buildWidgetLines(jobs: AsyncJobState[], theme: Theme, width = getTermWidth(), expanded = false, now: number = Date.now(), pulseFrame?: number): string[] {
	if (jobs.length === 0) return [];
	if (jobs.length === 1) return buildSingleWidgetLines(jobs[0]!, theme, width, expanded, now, pulseFrame);
	const running = jobs.filter((job) => job.status === "running");
	const queued = jobs.filter((job) => job.status === "queued");
	const finished = jobs.filter((job) => job.status !== "running" && job.status !== "queued");

	const lines: string[] = [];
	const hasActive = running.length > 0 || queued.length > 0;
	const headerGlyph = running.length > 0 ? runningPulseGlyph(pulseFrame) : hasActive ? "●" : "○";
	lines.push(truncLine(`${theme.fg(hasActive ? "accent" : "dim", headerGlyph)} ${theme.fg(hasActive ? "accent" : "dim", "Async agents")} ${theme.fg("dim", "· background")}`, width));

	const items: string[][] = [];
	let hiddenRunning = 0;
	let hiddenFinished = 0;
	let queuedSummaryShown = false;
	let slots = MAX_WIDGET_JOBS;

	for (const job of running) {
		if (slots <= 0) { hiddenRunning++; continue; }
		const stats = widgetStats(job, theme);
		items.push([
			`${widgetStatusGlyph(job, theme, pulseFrame)} ${themeBold(theme, widgetJobName(job))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
			`  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
			...widgetParallelAgentDetails(job, theme, expanded, width, now, pulseFrame),
		]);
		slots--;
	}

	if (queued.length > 0 && slots > 0) {
		items.push([`${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`]);
		queuedSummaryShown = true;
		slots--;
	}

	for (const job of finished) {
		if (slots <= 0) { hiddenFinished++; continue; }
		const stats = widgetStats(job, theme);
		items.push([
			`${widgetStatusGlyph(job, theme, pulseFrame)} ${themeBold(theme, widgetJobName(job))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
			`  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
			...widgetParallelAgentDetails(job, theme, expanded, width, now, pulseFrame),
		]);
		slots--;
	}

	const hiddenQueued = queued.length > 0 && !queuedSummaryShown ? queued.length : 0;
	const hiddenTotal = hiddenRunning + hiddenFinished + hiddenQueued;
	if (hiddenTotal > 0) {
		const parts: string[] = [];
		if (hiddenRunning > 0) parts.push(`${hiddenRunning} running`);
		if (hiddenQueued > 0) parts.push(`${hiddenQueued} queued`);
		if (hiddenFinished > 0) parts.push(`${hiddenFinished} finished`);
		items.push([theme.fg("dim", `+${hiddenTotal} more (${parts.join(", ")})`)]);
	}

	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		const last = i === items.length - 1;
		const branch = last ? "└─" : "├─";
		const continuation = last ? "   " : "│  ";
		lines.push(truncLine(`${theme.fg("dim", branch)} ${item[0]}`, width));
		for (const detail of item.slice(1)) {
			lines.push(truncLine(`${theme.fg("dim", continuation)} ${detail}`, width));
		}
	}

	return lines;
}

/**
 * Render the async jobs widget
 */
export function renderWidget(ctx: ExtensionContext, jobs: AsyncJobState[]): void {
	const ownerKey = getWidgetOwnerKey(ctx);
	if (jobs.length === 0) {
		if (widgetMounted && mountedWidgetOwnerKey !== ownerKey) {
			// With no visible job frame, stale-owner empty updates and newly-active
			// empty owners are indistinguishable here. Preserve active-widget safety;
			// host session disposal owns cross-owner empty-session teardown.
			return;
		}
		if (ctx.hasUI) setWidgetStatus(ctx, []);
		stopWidgetAnimation();
		return;
	}
	if (!ctx.hasUI) {
		stopWidgetAnimation();
		return;
	}
	latestWidgetCtx = ctx;
	latestWidgetJobs = [...jobs];
	refreshWidgetSnapshot(jobs);
	if (widgetMounted && mountedWidgetOwnerKey !== ownerKey) {
		// Session rebinding can leave the previous host UI alive briefly; clear the
		// old mount before installing the singleton widget on the new owner/context.
		unmountWidgetBestEffort(mountedWidgetCtx);
		mountedWidgetCtx = undefined;
		mountedWidgetOwnerKey = undefined;
		widgetMounted = false;
	}
	setWidgetStatus(ctx, jobs);
	if (!widgetMounted) {
		// belowEditor keeps the live async widget pinned to the bottom viewport,
		// matching the workflow companion widget's placement (#1109). The pulse frame
		// is advanced only by semantic async status updates, not by a cosmetic timer.
		ctx.ui.setWidget(WIDGET_KEY, buildWidgetComponent(getLatestWidgetJobs, getLatestWidgetExpanded, getLatestWidgetFrameNow, getLatestWidgetPulseFrame), {
			placement: "belowEditor",
		});
		mountedWidgetCtx = ctx;
		mountedWidgetOwnerKey = ownerKey;
		widgetMounted = true;
	} else {
		// The mounted widget reads latestWidgetJobs via getLatestWidgetJobs(), so a
		// visible->visible update only needs to ask the host to render in place. Keep
		// teardown pointed at the freshest same-owner wrapper because older wrappers
		// can go stale after host session/context rebinding.
		mountedWidgetCtx = ctx;
		mountedWidgetOwnerKey = ownerKey;
		requestWidgetRender(ctx);
	}
	// The async pulse is update-driven like foreground subagent results, so no
	// periodic cosmetic ticker is needed.
}
