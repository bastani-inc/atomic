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

interface WidgetAnimationState {
	latestCtx?: ExtensionContext;
	latestJobs: AsyncJobState[];
	frameNow: number;
	expanded: boolean;
	snapshotKey?: string;
	pulseFrame?: number;
	mountedCtx?: ExtensionContext;
	mountedOwnerKey?: string;
	surfaceKey?: object;
	mounted: boolean;
}

interface WidgetSurfaceState {
	activeOwner?: object;
}

interface WidgetRegistry {
	states: WeakMap<object, WidgetAnimationState>;
	surfaces: WeakMap<object, WidgetSurfaceState>;
}

const defaultWidgetOwner = {};

function getWidgetRegistry(): WidgetRegistry {
	const key = "__piSubagentWidgetRegistry";
	const globalStore = globalThis as Record<string, unknown>;
	const existing = globalStore[key] as WidgetRegistry | undefined;
	if (existing?.states instanceof WeakMap && existing.surfaces instanceof WeakMap) return existing;
	const registry: WidgetRegistry = { states: new WeakMap(), surfaces: new WeakMap() };
	globalStore[key] = registry;
	return registry;
}

function getWidgetState(owner: object): WidgetAnimationState {
	const registry = getWidgetRegistry();
	const existing = registry.states.get(owner);
	if (existing) return existing;
	const state: WidgetAnimationState = {
		latestJobs: [],
		frameNow: 0,
		expanded: false,
		mounted: false,
	};
	registry.states.set(owner, state);
	return state;
}

function getSurfaceState(surfaceKey: object): WidgetSurfaceState {
	const registry = getWidgetRegistry();
	const existing = registry.surfaces.get(surfaceKey);
	if (existing) return existing;
	const surface = {};
	registry.surfaces.set(surfaceKey, surface);
	return surface;
}

function getExpanded(state: WidgetAnimationState): boolean {
	if (!state.latestCtx?.hasUI) return state.expanded;
	const expanded = state.latestCtx.ui.getToolsExpanded?.();
	if (typeof expanded === "boolean") state.expanded = expanded;
	return state.expanded;
}

function clearWidgetState(state: WidgetAnimationState): void {
	state.latestCtx = undefined;
	state.latestJobs = [];
	state.frameNow = 0;
	state.expanded = false;
	state.snapshotKey = undefined;
	state.pulseFrame = undefined;
	state.mountedCtx = undefined;
	state.mountedOwnerKey = undefined;
	state.surfaceKey = undefined;
	state.mounted = false;
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

function refreshWidgetSnapshot(state: WidgetAnimationState, jobs: AsyncJobState[]): void {
	const snapshotKey = widgetSnapshotKey(jobs);
	if (snapshotKey === state.snapshotKey) return;
	state.snapshotKey = snapshotKey;
	state.frameNow = Date.now();
	state.pulseFrame = advanceResultPulseFrame(state.pulseFrame);
}

function releaseMountedWidget(state: WidgetAnimationState, owner: object): void {
	if (state.mounted) unmountWidgetBestEffort(state.mountedCtx);
	if (state.surfaceKey) {
		const surface = getSurfaceState(state.surfaceKey);
		if (surface.activeOwner === owner) surface.activeOwner = undefined;
	}
	clearWidgetState(state);
}

// Full teardown. Explicit API ownership is authoritative; logical context
// matching only protects context-driven teardown from stale session wrappers.
export function stopWidgetAnimation(ownerCtx?: ExtensionContext, owner: object = defaultWidgetOwner): void {
	const state = getWidgetState(owner);
	if (ownerCtx && state.mounted && state.mountedOwnerKey !== getWidgetOwnerKey(ownerCtx)) return;
	if (state.surfaceKey && getSurfaceState(state.surfaceKey).activeOwner !== owner) {
		clearWidgetState(state);
		return;
	}
	releaseMountedWidget(state, owner);
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

/** Render the async jobs widget for one ExtensionAPI owner. */
export function renderWidget(ctx: ExtensionContext, jobs: AsyncJobState[], owner: object = defaultWidgetOwner): void {
	const state = getWidgetState(owner);
	const ownerKey = getWidgetOwnerKey(ctx);
	const requestedSurfaceKey = ctx.ui.setWidget;
	const requestedSurface = getSurfaceState(requestedSurfaceKey);
	if (jobs.length === 0) {
		if (requestedSurface.activeOwner && requestedSurface.activeOwner !== owner) return;
		if (state.surfaceKey && getSurfaceState(state.surfaceKey).activeOwner !== owner) return;
		if (state.mounted && state.mountedOwnerKey !== ownerKey) return;
		if (ctx.hasUI) setWidgetStatus(ctx, []);
		stopWidgetAnimation(ctx, owner);
		return;
	}
	if (!ctx.hasUI) {
		stopWidgetAnimation(ctx, owner);
		return;
	}
	// Workflow stages forward the host's setWidget function, which identifies the
	// shared widget surface. A stage cannot replace a parent already active there.
	if (!state.mounted && requestedSurface.activeOwner && requestedSurface.activeOwner !== owner) return;
	state.latestCtx = ctx;
	state.latestJobs = [...jobs];
	refreshWidgetSnapshot(state, jobs);
	if (state.mounted && state.mountedOwnerKey !== ownerKey) {
		releaseMountedWidget(state, owner);
		state.latestCtx = ctx;
		state.latestJobs = [...jobs];
		refreshWidgetSnapshot(state, jobs);
	}
	setWidgetStatus(ctx, jobs);
	if (!state.mounted) {
		const surface = getSurfaceState(requestedSurfaceKey);
		if (surface.activeOwner && surface.activeOwner !== owner) return;
		ctx.ui.setWidget(WIDGET_KEY, buildWidgetComponent(
			() => state.latestJobs,
			() => getExpanded(state),
			() => state.frameNow,
			() => state.pulseFrame,
		), { placement: "belowEditor" });
		state.mountedCtx = ctx;
		state.mountedOwnerKey = ownerKey;
		state.surfaceKey = requestedSurfaceKey;
		state.mounted = true;
		surface.activeOwner = owner;
	} else {
		state.mountedCtx = ctx;
		state.mountedOwnerKey = ownerKey;
		requestWidgetRender(ctx);
	}
}
