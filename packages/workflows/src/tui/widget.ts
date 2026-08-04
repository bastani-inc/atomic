/**
 * Above-editor background-workflow widget.
 *
 * Visual contract (DESIGN.md §5):
 *  - One transparent rounded `BACKGROUND` panel with `N runs` and status
 *    badges (`✓ n  ● n  ○ n  ✗ n`) in the title.
 *  - One compact rounded card per run:
 *      title: `<status glyph>  <full id>`
 *      row 1: `<name> · <dim mode · progress · duration>`
 *  - Collapsed single-line form below 80 cells:
 *      `▾  N background · X ●` in dim+warning.
 *
 * Theme handling:
 *  - The widget always renders against the canonical Catppuccin Mocha
 *    palette (DESIGN.md "Status-Is-Truth"). Pi's runtime PiTheme is
 *    used only as a yes/no signal for ANSI: theme=undefined → plain
 *    text, theme=defined → coloured chrome.
 *
 * cross-ref:
 *  - github.com/nicobailon/pi-subagents src/tui/render.ts buildWidgetLines
 *  - src/tui/chat-surface.ts renderRoundedBoxLines
 */

import { effectiveRunStatus } from "../shared/returned-run-status.js";
import { runIndicatorStatus } from "../shared/run-indicator-status.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { RunSnapshot, StoreSnapshot } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import type { FlatBandBadge } from "./chat-surface.js";
import { renderRoundedBoxLines } from "./chat-surface.js";
import { hexToAnsi, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { deriveGraphTheme } from "./graph-theme.js";
import { renderRunIdentityRows } from "./run-identity-rows.js";
import { statusColor, statusIcon } from "./status-helpers.js";
import type { PiTheme } from "./store-widget-installer.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const RECENT_ENDED_WINDOW_MS = 30_000;
const COLLAPSED_BREAKPOINT_COLS = 80;

// ---------------------------------------------------------------------------
// Public formatters (kept for cross-module reuse)
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
	const totalSec = Math.floor(Math.max(0, ms) / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const minutes = Math.floor(totalSec / 60);
	const secs = totalSec % 60;
	if (minutes < 60) return `${minutes}m${secs > 0 ? ` ${secs}s` : ""}`;
	const hours = Math.floor(minutes / 60);
	const rmin = minutes % 60;
	return `${hours}h${rmin > 0 ? ` ${rmin}m` : ""}`;
}

// ---------------------------------------------------------------------------
// Run classification + selection
// ---------------------------------------------------------------------------

function isQuitRun(run: RunSnapshot): boolean {
	return run.endedAt === undefined && run.status === "paused" && run.exitReason === "quit";
}

function isActive(run: RunSnapshot): boolean {
	return run.endedAt === undefined && !isQuitRun(run);
}

function recentlyEnded(run: RunSnapshot, now: number): boolean {
	return run.endedAt !== undefined && now - run.endedAt <= RECENT_ENDED_WINDOW_MS;
}

/**
 * Returns the timestamp from which a quit card's display-only expiry is measured.
 * Older snapshots do not have `quitAt`, so retain the bounded legacy fallbacks.
 */
function quitExpiryTimestamp(run: RunSnapshot): number {
	return run.quitAt ?? run.pausedAt ?? run.startedAt;
}

function recentlyQuit(run: RunSnapshot, now: number): boolean {
	return isQuitRun(run) && now - quitExpiryTimestamp(run) <= RECENT_ENDED_WINDOW_MS;
}

interface RunCounts {
	active: number;
	paused: number;
	quit: number;
	done: number;
	blocked: number;
	failed: number;
	/** Runs with a pending HIL prompt — surfaced as a separate badge so the
	 *  user knows to attach via F2 before more progress is possible. */
	awaiting: number;
}

function subtreeAwaitsInput(root: RunSnapshot, allRuns: readonly RunSnapshot[]): boolean {
	return runIndicatorStatus(root, allRuns) === "awaiting_input";
}

function countRuns(runs: readonly RunSnapshot[], allRuns: readonly RunSnapshot[] = runs): RunCounts {
	const counts: RunCounts = { active: 0, paused: 0, quit: 0, done: 0, blocked: 0, failed: 0, awaiting: 0 };
	for (const r of runs) {
		const status = effectiveRunStatus(r);
		if (isQuitRun(r)) counts.quit++;
		else if (status === "blocked") counts.blocked++;
		else if (r.endedAt === undefined && status === "paused") counts.paused++;
		else if (r.endedAt === undefined) counts.active++;
		else if (status === "completed" || status === "skipped" || status === "cancelled") counts.done++;
		else if (status === "failed" || status === "killed") counts.failed++;
		if (r.endedAt === undefined && !isQuitRun(r) && subtreeAwaitsInput(r, allRuns)) counts.awaiting++;
	}
	return counts;
}

/**
 * Returns the next wall-clock boundary that can change the visible widget.
 * Running elapsed labels tick on exact one-second boundaries; paused runs stay
 * frozen. Recently ended and quit cards retain their independent one-shot expiry.
 * Reactive-widget updates the existing mounted component in place, so these
 * ticks repaint the visible panel without disposing or remounting it.
 */
export function nextWidgetRefreshDelayMs(snap: StoreSnapshot, now = Date.now()): number | undefined {
	const display = selectDisplayRuns(snap, now);
	if (display.length === 0) return undefined;

	const delays: number[] = [];
	for (const run of display) {
		if (run.endedAt !== undefined) {
			delays.push(Math.max(1, run.endedAt + RECENT_ENDED_WINDOW_MS - now + 1));
		} else if (isQuitRun(run)) {
			delays.push(Math.max(1, quitExpiryTimestamp(run) + RECENT_ENDED_WINDOW_MS - now + 1));
		}
	}
	for (const run of display) {
		if (run.endedAt !== undefined || effectiveRunStatus(run) !== "running" || run.pausedAt !== undefined) continue;
		const remainder = elapsedRunMs(run, now) % 1_000;
		delays.push(remainder === 0 ? 1_000 : 1_000 - remainder);
	}
	return delays.length === 0 ? undefined : Math.min(...delays);
}

function selectDisplayRuns(snap: StoreSnapshot, now: number): RunSnapshot[] {
	// Only surface top-level workflows. Nested `ctx.workflow()` child runs carry
	// a `parentRunId`, and they are already represented inline as flattened
	// stages of their parent's graph, so listing them here would show the same
	// composition three times (root + parent + child). Matches the visibility
	// rule `statusRuns`/the `status` action already apply.
	const all = topLevelWorkflowRuns(snap.runs);
	const active = all.filter((r) => isActive(r));
	const recent = all.filter((r) => recentlyEnded(r, now) || recentlyQuit(r, now));
	// Most recently started first within each bucket; active runs precede recent.
	const sort = (xs: RunSnapshot[]) => [...xs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
	return [...sort(active), ...sort(recent)];
}

// ---------------------------------------------------------------------------
// Per-run derived strings
// ---------------------------------------------------------------------------

function statusGlyph(run: RunSnapshot, allRuns: readonly RunSnapshot[]): string {
	if (isQuitRun(run)) return statusIcon("pending");
	return statusIcon(runIndicatorStatus(run, allRuns));
}

function statusFg(run: RunSnapshot, theme: GraphTheme, allRuns: readonly RunSnapshot[]): string {
	if (isQuitRun(run)) return theme.warning;
	const indicatorStatus = runIndicatorStatus(run, allRuns);
	if (indicatorStatus === "awaiting_input") return statusColor(indicatorStatus, theme);
	switch (effectiveRunStatus(run)) {
		case "running":
		case "paused":
			return theme.warning;
		case "completed":
			return theme.success;
		case "skipped":
		case "cancelled":
		case "blocked":
			return theme.dim;
		case "failed":
			return theme.error;
		case "killed":
			return theme.warning;
		default:
			return theme.dim;
	}
}

function modeLabel(run: RunSnapshot): string {
	return run.stages.length > 1 ? "chain" : "single";
}

function progressLabel(run: RunSnapshot): string | undefined {
	const total = run.stages.length;
	if (total === 0) return undefined;
	const done = run.stages.filter(
		(s) => s.status === "completed" || s.status === "failed" || s.status === "skipped",
	).length;
	return `${done}/${total}`;
}

function elapsedLabel(run: RunSnapshot, now: number): string {
	if (run.endedAt !== undefined) {
		const elapsed = formatDuration(elapsedRunMs(run, run.endedAt));
		const status = effectiveRunStatus(run);
		if (status === "completed") return `complete · ${elapsed}`;
		if (status === "failed") return `failed · ${elapsed}`;
		if (status === "killed") return `killed · ${elapsed}`;
		return `${status} · ${elapsed}`;
	}
	if (run.startedAt != null) return formatDuration(elapsedRunMs(run, now));
	return "";
}

function metaLine(run: RunSnapshot, now: number): string {
	if (run.endedAt !== undefined) {
		return elapsedLabel(run, now);
	}
	if (isQuitRun(run)) return "quit · resumable via /workflow resume";
	if (effectiveRunStatus(run) === "blocked") return "blocked · resumable via /workflow resume";
	const parts: string[] = [modeLabel(run)];
	const prog = progressLabel(run);
	if (prog) parts.push(prog);
	const elapsed = elapsedLabel(run, now);
	if (elapsed) parts.push(elapsed);
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Count badges for the band header
// ---------------------------------------------------------------------------

function countBadges(counts: RunCounts, theme: GraphTheme): FlatBandBadge[] {
	const badges: FlatBandBadge[] = [];
	if (counts.active > 0) {
		badges.push({ text: `● ${counts.active} running`, fg: theme.warning });
	}
	if (counts.paused > 0) {
		badges.push({ text: `❚❚ ${counts.paused} paused`, fg: theme.warning });
	}
	if (counts.quit > 0) {
		badges.push({ text: `${counts.quit} quit`, fg: theme.warning });
	}
	// Awaiting input is shown in Sky per DESIGN.md status semantics: a live
	// human-in-the-loop request that requires attention. Mirror the graph node's
	// question-mark status glyph, then keep ↵ as the attach/respond action hint.
	if (counts.awaiting > 0) {
		badges.push({
			text: `${statusIcon("awaiting_input")} ↵ ${counts.awaiting} needs attention (attach to workflow with \`/workflow connect\`)`,
			fg: theme.info,
		});
	}
	if (counts.blocked > 0) {
		badges.push({ text: `↑ ${counts.blocked} blocked`, fg: theme.warning });
	}
	if (counts.done > 0) {
		badges.push({ text: `✓ ${counts.done} complete`, fg: theme.success });
	}
	if (counts.failed > 0) {
		badges.push({ text: `✗ ${counts.failed} failed`, fg: theme.error });
	}
	return badges;
}

function formatTitleBadges(badges: readonly FlatBandBadge[], theme: GraphTheme, themed: boolean): string {
	if (badges.length === 0) return "";
	if (!themed) return badges.map((b) => b.text).join("  ");

	const fallbackFg = hexToAnsi(theme.border);
	return badges.map((b) => `${b.fg ? hexToAnsi(b.fg) : fallbackFg}${b.text}${RESET}${fallbackFg}`).join("  ");
}

// ---------------------------------------------------------------------------
// Themed rendering (ANSI + Catppuccin)
// ---------------------------------------------------------------------------

function themedRunLines(run: RunSnapshot, now: number, theme: GraphTheme, allRuns: readonly RunSnapshot[]): string[] {
	const meta = metaLine(run, now);
	// Render the meta line in muted while running so the elapsed-time
	// gradient stays readable; dim it once the run has terminated.
	const metaColor = effectiveRunStatus(run) === "running" ? theme.textMuted : theme.dim;
	return renderRunIdentityRows({
		runId: run.id,
		name: run.name,
		meta,
		glyph: statusGlyph(run, allRuns),
		glyphColor: statusFg(run, theme, allRuns),
		metaColor,
		theme,
	});
}

function plainRunLines(run: RunSnapshot, now: number, allRuns: readonly RunSnapshot[]): string[] {
	return renderRunIdentityRows({
		runId: run.id,
		name: run.name,
		meta: metaLine(run, now),
		glyph: statusGlyph(run, allRuns),
	});
}

// ---------------------------------------------------------------------------
// Collapsed (< 80 cell) form
// ---------------------------------------------------------------------------

function themedCollapsed(counts: RunCounts, theme: GraphTheme): string {
	const mauve = hexToAnsi(theme.mauve);
	const dim = hexToAnsi(theme.dim);
	const muted = hexToAnsi(theme.textMuted);
	const warning = hexToAnsi(theme.warning);
	const total = counts.active + counts.paused + counts.quit + counts.done + counts.blocked + counts.failed;
	const active = counts.active;
	const paused = counts.paused > 0 ? `${dim} · ${RESET}${warning}${counts.paused} ❚❚${RESET}` : "";
	const quit = counts.quit > 0 ? `${dim} · ${RESET}${warning}${counts.quit} quit${RESET}` : "";
	const blocked = counts.blocked > 0 ? `${dim} · ${RESET}${warning}${counts.blocked} ↑${RESET}` : "";
	return ` ${mauve}▾${RESET}  ${muted}${total} background${RESET}${dim} · ${RESET}${warning}${active} ●${RESET}${paused}${quit}${blocked}`;
}

function plainCollapsed(counts: RunCounts): string {
	const total = counts.active + counts.paused + counts.quit + counts.done + counts.blocked + counts.failed;
	const paused = counts.paused > 0 ? ` · ${counts.paused} ❚❚` : "";
	const quit = counts.quit > 0 ? ` · ${counts.quit} quit` : "";
	const blocked = counts.blocked > 0 ? ` · ${counts.blocked} ↑` : "";
	return ` ▾  ${total} background · ${counts.active} ●${paused}${quit}${blocked}`;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Build the widget lines for the current store snapshot.
 *
 * Returns `[]` when there are no active or recently-ended runs (the
 * widget hides entirely — DESIGN.md "earn every element").
 *
 * `piTheme` is treated as a boolean signal: defined → render ANSI
 * Catppuccin chrome; undefined → render plain text for test/headless
 * consumers.
 */
export function buildThemedWidgetLines(
	snap: StoreSnapshot,
	piTheme: PiTheme | undefined,
	width = 120,
	now = Date.now(),
): string[] {
	const display = selectDisplayRuns(snap, now);
	if (display.length === 0) return [];

	const displayCounts = countRuns(display, snap.runs);
	// Active + recently-ended dominate the badge counts so a finished run
	// visually persists for a beat before dropping off.
	const visibleCounts: RunCounts = {
		active: display.filter((r) => r.endedAt === undefined && effectiveRunStatus(r) === "running").length,
		paused: display.filter((r) => r.endedAt === undefined && effectiveRunStatus(r) === "paused" && !isQuitRun(r))
			.length,
		quit: display.filter(isQuitRun).length,
		done: display.filter(
			(r) => r.endedAt !== undefined && ["completed", "skipped", "cancelled"].includes(effectiveRunStatus(r)),
		).length,
		blocked: display.filter((r) => effectiveRunStatus(r) === "blocked").length,
		failed: display.filter((r) => r.endedAt !== undefined && ["failed", "killed"].includes(effectiveRunStatus(r)))
			.length,
		awaiting: displayCounts.awaiting,
	};

	const themed = piTheme !== undefined;
	const graphTheme = deriveGraphTheme({});

	// Collapsed single-line form for narrow terminals.
	if (width < COLLAPSED_BREAKPOINT_COLS) {
		return [themed ? themedCollapsed(visibleCounts, graphTheme) : plainCollapsed(visibleCounts)];
	}

	const total = display.length;
	const subtitle = `${total} run${total === 1 ? "" : "s"}`;

	const badgeList = countBadges(visibleCounts, graphTheme);
	const badges = formatTitleBadges(badgeList, graphTheme, themed);
	const title = `BACKGROUND  ${subtitle}${badges ? `  ${badges}` : ""}`;
	const body: string[] = [];

	for (let i = 0; i < display.length; i++) {
		const run = display[i]!;
		const runLines = themed ? themedRunLines(run, now, graphTheme, snap.runs) : plainRunLines(run, now, snap.runs);
		body.push(...runLines);
		if (i < display.length - 1) body.push("");
	}

	return renderRoundedBoxLines({
		title,
		bodyLines: body,
		accent: themed ? graphTheme.border : undefined,
		theme: themed ? graphTheme : undefined,
		width,
	});
}

/**
 * Plain-text widget entry point retained for tests and snapshot tooling.
 * Equivalent to `buildThemedWidgetLines(snap, undefined, width)`.
 */
export function renderWidgetLines(snap: StoreSnapshot, width = 120): string[] {
	return buildThemedWidgetLines(snap, undefined, width);
}
