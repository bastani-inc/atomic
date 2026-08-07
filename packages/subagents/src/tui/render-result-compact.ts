import { keyHintIfBound } from "@bastani/atomic";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { shortenPath } from "../shared/formatters.ts";
import type { AgentProgress, Details } from "../shared/types.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import { modelThinkingBadge } from "./render-event-formatting.ts";
import { getTermWidth, pulseGlyph, type Theme, truncLine } from "./render-layout.ts";
import { buildMultiProgressLabel, resultRowLabel } from "./render-progress.ts";
import {
	buildLiveStatusLine,
	compactCurrentActivity,
	extractOutputTarget,
	firstOutputLine,
	formatProgressStats,
	hasEmptyTextOutputWithoutOutputTarget,
	resultGlyph,
	resultStatusLine,
	snapshotNowForProgress,
	statJoin,
	themeBold,
} from "./render-status-progress.ts";

export function renderSingleCompact(
	d: Details,
	r: Details["results"][number],
	theme: Theme,
	now?: number,
	pulseFrame?: number,
): Component {
	const output = r.truncation?.text || getSingleResultOutput(r);
	const progress = r.progress || r.progressSummary;
	const isRunning = r.progress?.status === "running";
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const stats = statJoin(theme, [
		r.usage?.turns ? `⟳ ${r.usage.turns}` : "",
		formatProgressStats(theme, progress, true, now),
	]);
	const c = new Container();
	const width = getTermWidth() - 4;
	const modelDisplay = modelThinkingBadge(theme, r.model, undefined, r.fastMode);
	c.addChild(
		new Text(
			truncLine(
				`${resultGlyph(r, output, theme, isRunning, pulseFrame)} ${theme.fg("toolTitle", theme.bold(r.agent))}${modelDisplay}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
				width,
			),
			0,
			0,
		),
	);

	if (isRunning && r.progress) {
		const progressSnapshotNow = snapshotNowForProgress(r.progress, now);
		const activity = compactCurrentActivity(r.progress, now);
		c.addChild(new Text(truncLine(theme.fg("dim", `  ⎿  ${activity}`), width), 0, 0));
		const liveStatus = buildLiveStatusLine(r.progress, progressSnapshotNow);
		if (liveStatus && liveStatus !== activity)
			c.addChild(new Text(truncLine(theme.fg("dim", `     ${liveStatus}`), width), 0, 0));
		const expandHint = keyHintIfBound("app.tools.expand", "for live detail");
		if (expandHint) c.addChild(new Text(truncLine(theme.fg("accent", `  Press ${expandHint}`), width), 0, 0));
		if (r.artifactPaths)
			c.addChild(
				new Text(truncLine(theme.fg("dim", `  output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0),
			);
		return c;
	}

	c.addChild(new Text(truncLine(theme.fg("dim", `  ⎿  ${resultStatusLine(r, output)}`), width), 0, 0));
	const preview = firstOutputLine(output);
	if (preview && r.status === "ok" && !hasEmptyTextOutputWithoutOutputTarget(r.task, output)) {
		c.addChild(new Text(truncLine(theme.fg("dim", `     ${preview}`), width), 0, 0));
	}
	if (r.sessionFile)
		c.addChild(new Text(truncLine(theme.fg("dim", `  session: ${shortenPath(r.sessionFile)}`), width), 0, 0));
	if (r.artifactPaths)
		c.addChild(
			new Text(truncLine(theme.fg("dim", `  output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0),
		);
	if (r.truncation?.artifactPath)
		c.addChild(
			new Text(truncLine(theme.fg("dim", `  full output: ${shortenPath(r.truncation.artifactPath)}`), width), 0, 0),
		);
	return c;
}

export function renderMultiCompact(d: Details, theme: Theme, now?: number, pulseFrame?: number): Component {
	const hasRunning =
		d.progress?.some((p) => p.status === "running") || d.results.some((r) => r.progress?.status === "running");
	const failed = d.results.some((r) => r.status === "error" && r.progress?.status !== "running");
	const paused = d.results.some(
		(r) =>
			(r.interrupted ||
				r.detached ||
				r.status === "interrupted" ||
				r.status === "continued" ||
				r.status === "skipped") &&
			r.progress?.status !== "running",
	);
	let totalSummary = d.progressSummary;
	if (!totalSummary) {
		let sawProgress = false;
		const summary = { toolCount: 0, tokens: 0, durationMs: 0 };
		for (const r of d.results) {
			const prog = r.progress || r.progressSummary;
			if (!prog) continue;
			sawProgress = true;
			summary.toolCount += prog.toolCount;
			summary.tokens += prog.tokens;
			summary.durationMs = Math.max(summary.durationMs, prog.durationMs);
		}
		if (sawProgress) totalSummary = summary;
	}
	const multiLabel = buildMultiProgressLabel(d, hasRunning);
	const itemTitle = multiLabel.itemTitle;
	const stats = statJoin(theme, [multiLabel.headerLabel, formatProgressStats(theme, totalSummary, true, now)]);
	const glyph = hasRunning
		? theme.fg("accent", pulseGlyph(pulseFrame))
		: failed
			? theme.fg("error", "✗")
			: paused
				? theme.fg("warning", "■")
				: theme.fg("success", "✓");
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const c = new Container();
	const width = getTermWidth() - 4;
	c.addChild(
		new Text(
			truncLine(
				`${glyph} ${theme.fg("toolTitle", theme.bold(d.mode))}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
				width,
			),
			0,
			0,
		),
	);

	const progressSpan = d.progress?.length ? Math.max(...d.progress.map((p) => p.index + 1)) : 0;
	const resultsSpan = Math.max(d.results.length, progressSpan, d.mode === "parallel" ? (d.totalSteps ?? 0) : 0);
	const displayStart = multiLabel.showActiveGroupOnly ? multiLabel.groupStartIndex : 0;
	const displayEnd = multiLabel.showActiveGroupOnly ? multiLabel.groupEndIndex : resultsSpan;
	const renderEntries = Array.from({ length: displayEnd - displayStart }, (_, offset) => {
		const i = displayStart + offset;
		const r = d.results[i];
		const progressAgent = d.progress?.find((p) => p.index === i)?.agent;
		const fallbackLabel = itemTitle.toLowerCase();
		const rowNumber = multiLabel.showActiveGroupOnly ? i - multiLabel.groupStartIndex + 1 : i + 1;
		return {
			resultIndex: i,
			rowNumber,
			agentName: r?.agent || progressAgent || `${fallbackLabel}-${rowNumber}`,
		};
	});
	let liveDetailHintShown = false;
	for (const entry of renderEntries) {
		const i = entry.resultIndex;
		const r = d.results[i];
		const rowNumber = entry.rowNumber;
		const agentName = entry.agentName;
		if (!r) {
			const rowLabel = resultRowLabel(d, multiLabel, i, rowNumber);
			const runningProg = d.progress?.find((p) => p.index === i && p.status === "running") as
				| AgentProgress
				| undefined;
			if (runningProg) {
				const runningStats = formatProgressStats(theme, runningProg, true, now);
				const runningLine = `${theme.fg("accent", pulseGlyph(pulseFrame))} ${rowLabel}: ${themeBold(theme, agentName)}${runningStats ? ` ${theme.fg("dim", "·")} ${runningStats}` : ""}`;
				c.addChild(new Text(truncLine(`  ${runningLine}`, width), 0, 0));
				const activity = compactCurrentActivity(runningProg, now);
				c.addChild(new Text(truncLine(theme.fg("dim", `    ⎿  ${activity}`), width), 0, 0));
				const expandHint = keyHintIfBound("app.tools.expand", "for live detail");
				if (expandHint) {
					c.addChild(new Text(truncLine(theme.fg("accent", `    Press ${expandHint}`), width), 0, 0));
					liveDetailHintShown = true;
				}
				continue;
			}
			c.addChild(new Text(truncLine(theme.fg("dim", `  ◦ ${rowLabel}: ${agentName} · pending`), width), 0, 0));
			continue;
		}
		const output = getSingleResultOutput(r);
		const progressFromArray =
			d.progress?.find((p) => p.index === i) ||
			d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rProg = (r.progress || progressFromArray || r.progressSummary) as AgentProgress | undefined;
		const rRunning = rProg && "status" in rProg && rProg.status === "running";
		const rPending = rProg && "status" in rProg && rProg.status === "pending";
		const stepNumber =
			r.progress?.index !== undefined
				? r.progress.index + 1
				: progressFromArray?.index !== undefined
					? progressFromArray.index + 1
					: i + 1;
		const stepStats = formatProgressStats(theme, rProg, true, now);
		const glyph = rPending ? theme.fg("dim", "◦") : resultGlyph(r, output, theme, rRunning, pulseFrame);
		const pendingLabel = rPending ? ` ${theme.fg("dim", "· pending")}` : "";
		const stepLabel = resultRowLabel(d, multiLabel, i, stepNumber);
		const line = `${glyph} ${stepLabel}: ${themeBold(theme, agentName)}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}${pendingLabel}`;
		c.addChild(new Text(truncLine(`  ${line}`, width), 0, 0));
		if (rRunning && rProg && "status" in rProg) {
			const activity = compactCurrentActivity(rProg, now);
			c.addChild(new Text(truncLine(theme.fg("dim", `    ⎿  ${activity}`), width), 0, 0));
			const expandHint = keyHintIfBound("app.tools.expand", "for live detail");
			if (expandHint) {
				c.addChild(new Text(truncLine(theme.fg("accent", `    Press ${expandHint}`), width), 0, 0));
				liveDetailHintShown = true;
			}
		} else if (
			!rPending &&
			(r.status !== "ok" || r.interrupted || r.detached || hasEmptyTextOutputWithoutOutputTarget(r.task, output))
		) {
			c.addChild(
				new Text(
					truncLine(
						theme.fg(r.status === "error" ? "error" : "dim", `    ⎿  ${resultStatusLine(r, output)}`),
						width,
					),
					0,
					0,
				),
			);
		}
		const outputTarget = extractOutputTarget(r.task);
		if (outputTarget) c.addChild(new Text(truncLine(theme.fg("dim", `    output: ${outputTarget}`), width), 0, 0));
		if (r.artifactPaths)
			c.addChild(
				new Text(truncLine(theme.fg("dim", `    output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0),
			);
	}
	if (hasRunning && !liveDetailHintShown) {
		const groupHint = keyHintIfBound("app.tools.expand", "for live detail");
		if (groupHint) c.addChild(new Text(truncLine(theme.fg("accent", `  Press ${groupHint}`), width), 0, 0));
	}
	if (d.artifacts)
		c.addChild(new Text(truncLine(theme.fg("dim", `  artifacts: ${shortenPath(d.artifacts.dir)}`), width), 0, 0));
	return c;
}
