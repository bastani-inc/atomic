/**
 * `/workflow status` list — rounded workflow-tool output surface.
 *
 * Visual contract (DESIGN.md §5):
 *  - One rounded `BACKGROUND` panel with subtitle and count badges.
 *  - One rounded card per run (replaces the indented per-stage rows):
 *      title: full runId · workflow · state badge
 *      rows: status glyph + full runId, then workflow identity and meta
 *
 * Plain mode (theme omitted) preserves the rounded panel/card shape without
 * ANSI escapes, with ASCII bracket cells `[✓][●][○][✗]`.
 *
 * Powers:
 *   - `renderResult({ action: "status" })` (LLM tool path)
 *   - `/workflow session list` chat output (via renderSessionList)
 *   - `/workflow status` chat output
 *
 * cross-ref:
 *  - ui/mockups.html §2 (run list), §4 (truncation)
 *  - src/tui/chat-surface.ts shared primitives
 *  - src/tui/run-detail.ts per-run drill-down surface (unchanged)
 */

import { effectiveRunStatus } from "../shared/returned-run-status.js";
import type { RunIndicatorStatus } from "../shared/run-indicator-status.js";
import { runIndicatorStatus } from "../shared/run-indicator-status.js";
import type { RunSnapshot, StageSnapshot, StageStatus } from "../shared/store-types.js";
import { elapsedRunMs, elapsedStageMs } from "../shared/timing.js";
import type { FlatBandBadge } from "./chat-surface.js";
import { chatWidth, ELLIPSIS, progressStrip, renderRoundedBox } from "./chat-surface.js";
import { BOLD, hexToAnsi, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { wrapIdentifierLines } from "./run-identity-rows.js";
import { fmtDuration, statusColor, statusIcon } from "./status-helpers.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";

const STAGE_LABEL_BUDGET = 24;

export interface RenderStatusListOpts {
	/** Provide for ANSI Catppuccin; omit for plain text. */
	theme?: GraphTheme;
	/** Clock override (tests). */
	now?: number;
	/** When true, show a trailing hint pointing at the detail action. */
	showDetailHint?: boolean;
	/** Render width (cells). Defaults to `process.stdout.columns`. */
	width?: number;
	/** Point-in-time run collection used to attribute hidden child prompts. */
	allRuns?: readonly RunSnapshot[];
	/**
	 * Emit-time indicator status per run id, taking precedence over deriving
	 * from `allRuns`. Lets persisted payloads (e.g. the `/workflow status`
	 * chat entry) keep hidden-descendant prompt attribution after a session
	 * restore, when the full run collection is no longer available.
	 */
	indicatorStatuses?: Readonly<Record<string, RunIndicatorStatus>>;
}

function isQuitRun(run: RunSnapshot): boolean {
	return run.endedAt === undefined && run.status === "paused" && run.exitReason === "quit";
}

/**
 * Render a list of run snapshots as the canonical rounded `BACKGROUND`
 * surface: one panel plus one card per run.
 */
export function renderStatusList(runs: readonly RunSnapshot[], opts: RenderStatusListOpts = {}): string {
	const now = opts.now ?? Date.now();
	const width = effectiveWidth(opts.width);
	const cardWidth = Math.max(20, width - 4);

	// The list shows active + recently-ended runs together. Sorting:
	// active first, then ended, each bucket by startedAt desc.
	const sorted = sortRuns(runs);

	// Header counts span the whole snapshot, not just the display window.
	const counts = countBuckets(runs);
	const subtitle = `${sorted.length} run${sorted.length === 1 ? "" : "s"}`;
	const badges: FlatBandBadge[] | undefined = opts.theme ? themedBadges(counts, opts.theme) : plainBadges(counts);

	const body: string[] = [];

	if (sorted.length === 0) {
		body.push(` ${emptyStateLine(opts.theme)} `);
	} else {
		for (let i = 0; i < sorted.length; i++) {
			if (i > 0) body.push("");
			body.push(
				...renderRunEntry(sorted[i]!, now, cardWidth, opts.theme, opts.allRuns ?? runs, opts.indicatorStatuses),
			);
		}
	}
	if (opts.showDetailHint !== false && sorted.length > 0) {
		body.push("");
		body.push(...renderStatusHintRows(sorted[0]!.id, opts.theme, width).map((line) => ` ${line} `));
	}
	const badgeText = badges && badges.length > 0 ? `  ${badges.map((b) => b.text).join("  ")}` : "";
	return renderRoundedBox({
		title: `BACKGROUND  ${subtitle}${badgeText}`,
		bodyLines: body,
		theme: opts.theme,
		width,
	});
}

// ---------------------------------------------------------------------------
// Run card
// ---------------------------------------------------------------------------

function renderRunEntry(
	run: RunSnapshot,
	now: number,
	width: number,
	theme: GraphTheme | undefined,
	allRuns: readonly RunSnapshot[],
	indicatorStatuses?: Readonly<Record<string, RunIndicatorStatus>>,
): string[] {
	const bodyWidth = effectiveWidth(width);
	const interior = Math.max(8, bodyWidth - 4);
	const indicatorStatus = indicatorStatuses?.[run.id] ?? runIndicatorStatus(run, allRuns);
	const glyph = statusIconForRun(run, indicatorStatus);
	const glyphFg = theme ? hexToAnsi(runAccent(run, theme, indicatorStatus)) : "";
	const accent = theme ? hexToAnsi(theme.accent) : "";
	const text = theme ? hexToAnsi(theme.text) : "";
	const muted = theme ? hexToAnsi(theme.textMuted) : "";
	const dim = theme ? hexToAnsi(theme.dim) : "";
	const reset = theme ? RESET : "";

	// The identifier owns its row and is never sent through truncateToWidth.
	// At narrow widths, continuation rows preserve every identifier character
	// while keeping each row inside the rounded panel's interior.
	const idRows = wrapIdentifierLines(run.id, interior, ` ${glyph}  `, "   ");
	const identityRows = idRows.map(({ prefix, chunk }, index) => {
		if (!theme) return `${prefix}${chunk}`;
		if (index === 0) return ` ${glyphFg}${glyph}${RESET}  ${accent}${chunk}${RESET}`;
		return `   ${accent}${chunk}${RESET}`;
	});

	const trailing = runTrailing(run, theme);
	const trailingText = truncateToWidth(trailing?.text ?? "", Math.max(0, interior - 1), ELLIPSIS);
	const nameBudget = Math.max(1, interior - 3 - visibleWidth(trailingText) - (trailingText ? 2 : 0));
	const name = truncateToWidth(run.name, nameBudget, ELLIPSIS);
	const nameSeg = theme ? `${text}${BOLD}${name}${RESET}` : name;
	const trailingSeg =
		theme && trailingText ? `${hexToAnsi(trailing?.fg ?? theme.dim)}${trailingText}${RESET}` : trailingText;
	const identity = `   ${nameSeg}${trailingSeg ? `  ${trailingSeg}` : ""}`;

	const mode = run.stages.length > 1 ? "chain " : "single";
	const rawMeta = runCardMeta(run, now);
	const modeW = mode.length + 4;
	const maxMetaW = Math.max(0, interior - modeW - 3);
	const meta = truncateToWidth(rawMeta, maxMetaW, ELLIPSIS);
	const metaW = visibleWidth(meta);
	const stripBudget = Math.max(0, interior - modeW - metaW - 2);
	const strip = progressStrip(stageCells(run), stripBudget, theme);
	const usedLeftW = modeW + visibleWidth(strip);
	const gap = Math.max(metaW > 0 ? 1 : 0, interior - usedLeftW - metaW);
	const modeSeg = theme ? `${muted}${mode}${reset}` : mode;
	const metaSeg = theme ? `${dim}${meta}${reset}` : meta;
	const metaLine = `   ${modeSeg}    ${strip}${" ".repeat(gap)}${metaSeg} `;

	return [...identityRows, identity, metaLine];
}

function runAccent(run: RunSnapshot, theme: GraphTheme | undefined, indicatorStatus: RunIndicatorStatus): string {
	if (!theme) return "#000000";
	if (isQuitRun(run)) return theme.warning;
	return statusColor(indicatorStatus, theme);
}

function runTrailing(run: RunSnapshot, theme?: GraphTheme): { text: string; fg?: string } | undefined {
	if (isQuitRun(run)) return { text: "○ quit", fg: theme?.warning };
	switch (effectiveRunStatus(run)) {
		case "completed":
			return { text: "✓ completed", fg: theme?.success };
		case "running":
			return { text: "● running", fg: theme?.warning };
		case "paused":
			return { text: "❚❚ paused", fg: theme?.warning };
		case "skipped":
			return { text: "⊘ skipped", fg: theme?.dim };
		case "cancelled":
			return { text: "⊘ cancelled", fg: theme?.dim };
		case "blocked":
			return { text: "↑ blocked", fg: theme?.dim };
		case "failed":
			return { text: "✗ failed", fg: theme?.error };
		case "killed":
			return { text: "⊘ killed", fg: theme?.error };
		default:
			return { text: "○ pending", fg: theme?.dim };
	}
}

function runCardMeta(run: RunSnapshot, now: number): string {
	// Builds the right-aligned meta tail.
	//   running  → `3/8 · review-a · 1m42s`
	//   paused   → `3/8 · review-a · 1m42s` (elapsed is frozen by pausedAt)
	//   failed   → `failed at partition · 4m24s ago`
	//   killed   → `<stage> · <duration> · <when>` (mirrors mockup §2)
	//   completed→ `<stage> · <duration> · <when>`
	const parts: string[] = [];
	const isChain = run.stages.length > 1;
	const total = run.stages.length;
	const done = run.stages.filter(
		(s) => s.status === "completed" || s.status === "failed" || s.status === "skipped",
	).length;
	const ago =
		run.endedAt !== undefined
			? `${fmtDuration(now - run.endedAt)} ago`
			: run.startedAt != null
				? fmtDuration(elapsedRunMs(run, now))
				: undefined;

	if (isQuitRun(run)) return "resumable via /workflow resume";
	if (effectiveRunStatus(run) === "running") {
		if (isChain) parts.push(`${done}/${total}`);
		const labels = runningStageLabels(run);
		if (labels) parts.push(labels);
		if (ago) parts.push(ago);
		return parts.join(" · ");
	}

	if (effectiveRunStatus(run) === "paused") {
		if (isChain) parts.push(`${done}/${total}`);
		const labels = pausedStageLabels(run);
		if (labels) parts.push(labels);
		if (ago) parts.push(ago);
		return parts.join(" · ");
	}

	if (effectiveRunStatus(run) === "failed" || effectiveRunStatus(run) === "killed") {
		if (run.exitReason !== undefined && run.exitReason.length > 0 && run.exited === true) parts.push(run.exitReason);
		const failed = run.stages.find((s) => s.status === "failed");
		if (failed && isChain) parts.push(`failed at ${failed.name}`);
		else if (failed) parts.push(failed.name);
		else if (!isChain && run.stages[0]) parts.push(run.stages[0].name);
		const dur = lastStageDuration(run, now);
		if (dur && parts.length < 2) parts.push(dur);
		if (ago) parts.push(ago);
		return parts.join(" · ");
	}

	if (["completed", "skipped", "cancelled", "blocked"].includes(effectiveRunStatus(run))) {
		if (run.exitReason !== undefined && run.exitReason.length > 0) parts.push(run.exitReason);
		if (!isChain && run.stages[0]) parts.push(run.stages[0].name);
		const dur = lastStageDuration(run, now);
		if (dur) parts.push(dur);
		if (ago) parts.push(ago);
		return parts.join(" · ");
	}

	// pending
	if (ago) parts.push(ago);
	return parts.join(" · ");
}

function runningStageLabels(run: RunSnapshot): string | undefined {
	const running = run.stages.filter((s) => s.status === "running").map((s) => s.name);
	if (running.length === 0) return undefined;
	const joined = running.join(", ");
	return truncateToWidth(joined, STAGE_LABEL_BUDGET, ELLIPSIS);
}

function pausedStageLabels(run: RunSnapshot): string | undefined {
	const paused = run.stages.filter((s) => s.status === "paused").map((s) => s.name);
	if (paused.length === 0) return undefined;
	const joined = paused.join(", ");
	return truncateToWidth(joined, STAGE_LABEL_BUDGET, ELLIPSIS);
}

function lastStageDuration(run: RunSnapshot, now: number): string | undefined {
	// Pick a representative stage duration: the most-recent terminal stage,
	// or the running stage if everything's still in flight.
	const candidate =
		[...run.stages]
			.reverse()
			.find((s) => s.status === "completed" || s.status === "failed" || s.status === "skipped") ??
		run.stages.find((s) => s.status === "running");
	if (!candidate) return undefined;
	return stageDurationString(candidate, now);
}

function stageDurationString(stage: StageSnapshot, now: number): string | undefined {
	const elapsed = elapsedStageMs(stage, now);
	return elapsed === undefined ? undefined : fmtDuration(elapsed);
}

function stageCells(run: RunSnapshot): Array<{ status: StageStatus }> {
	// Single-stage runs render a single cell mirroring run status. Chain
	// runs render one cell per stage.
	if (run.stages.length === 0) {
		return [{ status: stageStatusFromRun(run) }];
	}
	return run.stages.map((s) => ({ status: s.status }));
}

function stageStatusFromRun(run: RunSnapshot): StageStatus {
	switch (effectiveRunStatus(run)) {
		case "completed":
			return "completed";
		case "skipped":
			return "skipped";
		case "cancelled":
			return "skipped";
		case "blocked":
			return "blocked";
		case "running":
			return "running";
		case "paused":
			return "paused";
		case "failed":
			return "failed";
		case "killed":
			return "failed";
		default:
			return "pending";
	}
}

/**
 * Resolve the render width for the status surface. Delegates to the
 * shared `chatWidth()` helper which already accounts for the chat host's
 * 2-cell horizontal padding when no explicit width is supplied.
 */
function effectiveWidth(width?: number): number {
	return chatWidth(width);
}

// ---------------------------------------------------------------------------
// Buckets + badges
// ---------------------------------------------------------------------------

interface Counts {
	active: number;
	paused: number;
	quit: number;
	completed: number;
	blocked: number;
	failed: number;
	pending: number;
}

function countBuckets(runs: readonly RunSnapshot[]): Counts {
	const c: Counts = { active: 0, paused: 0, quit: 0, completed: 0, blocked: 0, failed: 0, pending: 0 };
	for (const r of runs) {
		const status = effectiveRunStatus(r);
		if (isQuitRun(r)) c.quit++;
		else if (r.endedAt === undefined) {
			if (status === "pending") c.pending++;
			else if (status === "paused") c.paused++;
			else if (status === "running") c.active++;
			else if (status === "completed") c.completed++;
			else if (status === "blocked") c.blocked++;
			else c.failed++;
		} else if (status === "completed") c.completed++;
		else if (status === "blocked") c.blocked++;
		else if (status === "skipped" || status === "cancelled") c.completed++;
		else c.failed++;
	}
	return c;
}

function themedBadges(c: Counts, theme: GraphTheme): FlatBandBadge[] {
	const out: FlatBandBadge[] = [];
	if (c.completed > 0) out.push({ text: `✓ ${c.completed}`, fg: theme.success });
	if (c.blocked > 0) out.push({ text: `↑ ${c.blocked} blocked`, fg: theme.warning });
	if (c.active > 0) out.push({ text: `● ${c.active}`, fg: theme.warning });
	// Keep the word label: the pause glyph is less familiar than the other
	// status glyphs, so this intentional asymmetry improves scanability.
	if (c.paused > 0) out.push({ text: `❚❚ ${c.paused} paused`, fg: theme.warning });
	if (c.quit > 0) out.push({ text: `${c.quit} quit`, fg: theme.warning });
	if (c.pending > 0) out.push({ text: `○ ${c.pending}`, fg: theme.dim });
	if (c.failed > 0) out.push({ text: `⊘ ${c.failed}`, fg: theme.error });
	return out;
}

function plainBadges(c: Counts): FlatBandBadge[] {
	const out: FlatBandBadge[] = [];
	if (c.completed > 0) out.push({ text: `✓ ${c.completed}` });
	if (c.blocked > 0) out.push({ text: `↑ ${c.blocked} blocked` });
	if (c.active > 0) out.push({ text: `● ${c.active}` });
	// Keep the word label: the pause glyph is less familiar than the other
	// status glyphs, so this intentional asymmetry improves scanability.
	if (c.paused > 0) out.push({ text: `❚❚ ${c.paused} paused` });
	if (c.quit > 0) out.push({ text: `${c.quit} quit` });
	if (c.pending > 0) out.push({ text: `○ ${c.pending}` });
	if (c.failed > 0) out.push({ text: `⊘ ${c.failed}` });
	return out;
}

// ---------------------------------------------------------------------------
// Sorting + helpers
// ---------------------------------------------------------------------------

function sortRuns(runs: readonly RunSnapshot[]): RunSnapshot[] {
	const active = runs.filter((r) => r.endedAt === undefined);
	const ended = runs.filter((r) => r.endedAt !== undefined);
	const byStart = (a: RunSnapshot, b: RunSnapshot) => (b.startedAt ?? 0) - (a.startedAt ?? 0);
	return [...[...active].sort(byStart), ...[...ended].sort(byStart)];
}

function renderStatusHintRows(id: string, theme: GraphTheme | undefined, width: number): string[] {
	const budget = Math.max(1, width - 4);
	const prefix = "▸ /workflow status ";
	const continuation = "  ";
	const rows = wrapIdentifierLines(id, budget, prefix, continuation);
	const identifierRowCount = rows.length;
	const suffix = "  drill into a run";
	const last = rows[rows.length - 1]!;
	if (visibleWidth(`${last.prefix}${last.chunk}${suffix}`) <= budget) {
		last.chunk += suffix;
	} else {
		rows.push({
			prefix: continuation,
			chunk: truncateToWidth(suffix.trimStart(), Math.max(1, budget - visibleWidth(continuation)), ELLIPSIS),
		});
	}
	if (!theme) return rows.map((row) => `${row.prefix}${row.chunk}`);
	const dim = hexToAnsi(theme.dim);
	const accent = hexToAnsi(theme.accent);
	return rows.map((row, index) => {
		const carriesIdentifier = index < identifierRowCount;
		const carriesSuffix = carriesIdentifier && index === identifierRowCount - 1 && row.chunk.endsWith(suffix);
		const idChunk = carriesSuffix ? row.chunk.slice(0, -suffix.length) : row.chunk;
		const suffixText = carriesSuffix ? suffix : "";
		if (index === 0) {
			return `${dim}▸${RESET} ${accent}/workflow status ${idChunk}${RESET}${suffixText ? `${dim}${suffixText}${RESET}` : ""}`;
		}
		if (carriesIdentifier) {
			return `${row.prefix}${accent}${idChunk}${RESET}${suffixText ? `${dim}${suffixText}${RESET}` : ""}`;
		}
		return `${row.prefix}${dim}${row.chunk}${RESET}`;
	});
}

function emptyStateLine(theme?: GraphTheme): string {
	if (!theme) return "  no workflow runs in current session";
	return `  ${hexToAnsi(theme.dim)}no workflow runs in current session${RESET}`;
}

function statusIconForRun(run: RunSnapshot, indicatorStatus: RunIndicatorStatus): string {
	if (isQuitRun(run)) return statusIcon("pending");
	return statusIcon(indicatorStatus);
}

// Re-export for callers that need to inspect width budgeting.
