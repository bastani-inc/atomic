/** Pure progress-trend evidence shared by subagent control decisions. */

export const DEFAULT_TREND_WINDOW = 3;
export const DEFAULT_RISE_DELTA = 1.5;
export const DEFAULT_FALL_DELTA = -1.5;
export const FLAT_LOW_SCORE_CEILING = 8;
export const PROGRESS_ATTENTION_THRESHOLD_FRACTION = 0.5;

export type TrendConfig = {
	window?: number;
	riseDelta?: number;
	fallDelta?: number;
};

export type Trend = "rising" | "flat" | "regressing";

export type TrendResult = {
	trend: Trend;
	evidence: {
		series: readonly number[];
		window: number;
		delta: number;
	};
};

function mean(values: readonly number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Classify a score series using the change in mean score between successive windows.
 * The result is evidence only: it carries no run action or terminal status.
 */
export function classify_trend(series: readonly number[], config: TrendConfig = {}): TrendResult {
	const window = config.window ?? DEFAULT_TREND_WINDOW;
	const riseDelta = config.riseDelta ?? DEFAULT_RISE_DELTA;
	const fallDelta = config.fallDelta ?? DEFAULT_FALL_DELTA;
	if (series.length < window + 1) {
		return { trend: "flat", evidence: { series, window, delta: 0 } };
	}
	const sample = series.slice(-2 * window);
	const usableLength = sample.length % 2 === 1 ? sample.length - 1 : sample.length;
	const halfLength = usableLength / 2;
	const leading = sample.slice(0, halfLength);
	const trailing = sample.slice(sample.length - halfLength);
	const delta = halfLength === 0 ? 0 : mean(trailing) - mean(leading);
	const trend: Trend = delta >= riseDelta ? "rising" : delta <= fallDelta ? "regressing" : "flat";
	return { trend, evidence: { series, window, delta } };
}

function hasFiniteProgressScores(series: readonly number[] | undefined): series is readonly number[] {
	return series !== undefined && series.length > 0 && series.every((score) => Number.isFinite(score));
}

export function hasProgressAttentionSignal(series: readonly number[] | undefined): boolean {
	if (!hasFiniteProgressScores(series)) return false;
	const result = classify_trend(series);
	const latest = series.at(-1);
	return (
		result.trend === "regressing" ||
		(result.trend === "flat" && latest !== undefined && latest <= FLAT_LOW_SCORE_CEILING)
	);
}

/** Lower a wall-clock threshold only when progress evidence raises priority. */
export function progressAwareThreshold(baseMs: number, series: readonly number[] | undefined): number {
	return hasProgressAttentionSignal(series) ? Math.max(1, baseMs * PROGRESS_ATTENTION_THRESHOLD_FRACTION) : baseMs;
}
