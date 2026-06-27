import type { ExtensionContext } from "@bastani/atomic";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentProgress } from "../shared/types.ts";

export type Theme = ExtensionContext["ui"]["theme"];

export function getTermWidth(): number {
	return process.stdout.columns || 120;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 *
 * pi-tui's truncateToWidth adds \x1b[0m before ellipsis which resets all styling,
 * causing background color bleed in the TUI. This implementation tracks active
 * ANSI styles and re-applies them before the ellipsis.
 *
 * Uses Intl.Segmenter for proper Unicode/emoji handling (not char-by-char).
 */
export function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;

	const targetWidth = maxWidth - 1;
	let result = "";
	let currentWidth = 0;
	let activeStyles: string[] = [];
	let i = 0;

	while (i < text.length) {
		const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
		if (ansiMatch) {
			const code = ansiMatch[0];
			result += code;

			if (code === "\x1b[0m" || code === "\x1b[m") {
				activeStyles = [];
			} else {
				activeStyles.push(code);
			}
			i += code.length;
			continue;
		}

		let end = i;
		while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
			end++;
		}

		const textPortion = text.slice(i, end);
		for (const seg of segmenter.segment(textPortion)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);

			if (currentWidth + graphemeWidth > targetWidth) {
				return result + activeStyles.join("") + "…";
			}

			result += grapheme;
			currentWidth += graphemeWidth;
		}
		i = end;
	}

	return result + activeStyles.join("") + "…";
}

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Spinner cadence (ms per frame). The running glyph is derived from wall-clock
 * time so every active spinner advances smoothly and in lockstep, independent
 * of how often (or how irregularly) progress data updates arrive. The animation
 * timers below only schedule re-renders; the displayed frame always comes from
 * the clock. This fixes the frozen/stuttering spinner from issue #1084.
 *
 * IMPORTANT: a wall-clock spinner only stays flicker-free for widgets pinned to
 * the bottom of the buffer (e.g. the below-editor async widget), where every
 * tick stays inside the viewport. Content rendered into chat scrollback (live
 * foreground subagent results) can scroll above the viewport fold; there, even
 * a single-cell spinner diff forces pi-tui into a destructive full-screen +
 * scrollback clear on every tick. Such surfaces must NOT animate on a timer —
 * see pulseGlyph(), which is advanced once per real progress update instead.
 */
export const RUNNING_ANIMATION_MS = 80;

type ProgressSeedSource = Partial<Pick<AgentProgress, "index" | "toolCount" | "tokens" | "durationMs" | "lastActivityAt" | "currentToolStartedAt" | "turnCount">>;

/**
 * Wall-clock-derived animation frame counter. Advances exactly one step every
 * `RUNNING_ANIMATION_MS`. Exposed for tests so they can pin a deterministic now.
 */
export function currentRunningFrame(now: number = Date.now()): number {
	return Math.floor(now / RUNNING_ANIMATION_MS);
}

export function runningSeed(...values: Array<number | undefined>): number | undefined {
	let seed: number | undefined;
	for (const value of values) {
		if (value === undefined || !Number.isFinite(value)) continue;
		seed = (seed ?? 0) + Math.trunc(value);
	}
	return seed;
}

export function runningGlyph(seed?: number, now?: number): string {
	// Fold the wall-clock frame into the (optional) progress seed so the glyph
	// advances over time. Callers that render into chat scrollback can pass a
	// captured `now` so host re-renders do not mutate already-emitted lines.
	const animatedSeed = runningSeed(seed, currentRunningFrame(now)) ?? 0;
	return RUNNING_FRAMES[Math.abs(animatedSeed) % RUNNING_FRAMES.length]!;
}

const PULSE_FRAMES = ["·", "•", "●", "•"];

/**
 * Activity "heartbeat" glyph for live foreground subagent results. Unlike
 * runningGlyph(), the frame is NOT derived from wall-clock time: the caller
 * advances `frame` exactly once per real progress update (see
 * renderLiveSubagentResult). With no animation timer, the only line diffs this
 * produces coincide with progress data that genuinely changed, so the pulse can
 * live in chat scrollback (above or below the fold) without ever triggering
 * pi-tui's full-screen/scrollback clear. Returns a steady breathing dot that
 * grows and settles as the subagent reports activity.
 */
export function pulseGlyph(frame?: number): string {
	const index = Number.isFinite(frame) ? Math.abs(Math.trunc(frame as number)) : 0;
	return PULSE_FRAMES[index % PULSE_FRAMES.length]!;
}

export function progressRunningSeed(progress: ProgressSeedSource | undefined): number | undefined {
	if (!progress) return undefined;
	return runningSeed(
		progress.index,
		progress.toolCount,
		progress.tokens,
		progress.durationMs,
		progress.lastActivityAt,
		progress.currentToolStartedAt,
		progress.turnCount,
	);
}
