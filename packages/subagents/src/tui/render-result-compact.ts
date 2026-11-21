import { formatTokenSegment, keyHintIfBound, navEntryKeyParts, TASK_MARKS } from "@bastani/atomic";
import { type Component, Container, clickableKeysHint, getKeybindings, Text } from "@bastani/atomic-tui";
import { formatDuration, shortenPath } from "../shared/formatters.js";
import type { AgentProgress, Details } from "../shared/types.js";
import { getSingleResultOutput } from "../shared/utils.js";
import { modelThinkingBadge } from "./render-event-formatting.js";
import { getTermWidth, type Theme, truncLine } from "./render-layout.js";
import { buildMultiProgressLabel, resultRowLabel } from "./render-progress.js";
import {
	compactCurrentActivity,
	displayProgressDurationMs,
	extractOutputTarget,
	firstOutputLine,
	formatProgressStats,
	formatToolUseStat,
	hasEmptyTextOutputWithoutOutputTarget,
	markText,
	resultGlyph,
	resultStatusLine,
	statJoin,
	themeBold,
} from "./render-status-progress.js";

export const RUNNING_BLOCK_RECENT_TOOLS = 3;

export function renderSingleCompact(d: Details, r: Details["results"][number], theme: Theme, now?: number): Component {
	return {
		render(width) {
			if (width < 1) return [];
			return renderSingleCompactAtWidth(d, r, theme, Math.floor(width), now).render(width);
		},
		invalidate() {},
	};
}

function renderSingleCompactAtWidth(
	_d: Details,
	r: Details["results"][number],
	theme: Theme,
	width: number,
	now?: number,
): Component {
	const output = r.truncation?.text || getSingleResultOutput(r);
	const progress = r.progress || r.progressSummary;
	const isRunning = r.progress?.status === "running";
	const c = new Container();
	const glyph = resultGlyph(r, output, theme, isRunning);

	if (isRunning && r.progress) {
		const hasCurrentTool = Boolean(r.progress.currentTool);
		const recentLimit = RUNNING_BLOCK_RECENT_TOOLS - (hasCurrentTool ? 1 : 0);
		const recent = recentLimit > 0 ? r.progress.recentTools.slice(-recentLimit) : [];
		const current = compactCurrentActivity(r.progress, now);
		const toolLines = recent.map((tool) => (tool.args ? `${tool.tool}: ${tool.args}` : tool.tool));
		const displayed = hasCurrentTool ? [...toolLines, current] : toolLines;
		const lines = hasCurrentTool ? displayed : [...displayed, current];
		const folded = Math.max(0, r.progress.toolCount - displayed.length);
		if (folded > 0)
			c.addChild(new Text(truncLine(theme.fg("dim", `  ⎿  … +${formatToolUseStat(folded)}`), width), 0, 0));
		lines.forEach((line, index) => {
			const prefix = index === 0 && folded === 0 ? "  ⎿  " : "     ";
			c.addChild(new Text(truncLine(theme.fg("dim", `${prefix}${line}`), width), 0, 0));
		});
		const elapsedMs = displayProgressDurationMs(r.progress, now);
		const running = statJoin(theme, [
			"Running",
			elapsedMs >= 1000 ? formatDuration(elapsedMs) : "",
			formatTokenSegment({
				mode: "receiving",
				count: r.progress.tokens,
			}),
		]);
		const manageKeys = navEntryKeyParts(getKeybindings(), { action: "app.agents.focus", label: "to manage" });
		const hint =
			manageKeys.length > 0
				? clickableKeysHint(manageKeys, " to manage")
				: keyHintIfBound("app.tools.expand", "for live detail");
		const runningLine = `${running}${hint ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", hint)}` : ""}`;
		c.addChild(new Text(truncLine(`  ${theme.fg("dim", "⎿")}  ${runningLine}`, width), 0, 0));
		if (r.artifactPaths)
			c.addChild(
				new Text(
					truncLine(theme.fg("dim", `     output: ${shortenPath(r.artifactPaths.outputPath)}`), width),
					0,
					0,
				),
			);
		return c;
	}

	const finished = r.status === "ok" && !r.detached && !r.interrupted;
	const outcome = finished ? "finished" : resultStatusLine(r, output).toLowerCase();
	const durationMs = progress ? displayProgressDurationMs(progress, now) : 0;
	const stats = durationMs > 0 ? theme.fg("dim", formatDuration(durationMs)) : "";
	const outcomeGlyph = finished ? markText(theme, TASK_MARKS.done) : glyph;
	c.addChild(
		new Text(
			truncLine(
				`${outcomeGlyph} ${theme.fg("toolTitle", themeBold(theme, r.agent))} ${theme.fg("dim", outcome)}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
				width,
			),
			0,
			0,
		),
	);
	const headline = firstOutputLine(output);
	const showHeadline = headline && r.status === "ok" && !hasEmptyTextOutputWithoutOutputTarget(r.task, output);
	c.addChild(
		new Text(
			truncLine(theme.fg("dim", `  ⎿  ${showHeadline ? headline : resultStatusLine(r, output)}`), width),
			0,
			0,
		),
	);
	const expand = keyHintIfBound("app.tools.expand", "for prompt, tool calls and full result");
	if (expand) c.addChild(new Text(truncLine(theme.fg("dim", `     (${expand})`), width), 0, 0));
	if (r.artifactPaths)
		c.addChild(
			new Text(truncLine(theme.fg("dim", `     output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0),
		);
	if (r.truncation?.artifactPath)
		c.addChild(
			new Text(
				truncLine(theme.fg("dim", `     full output: ${shortenPath(r.truncation.artifactPath)}`), width),
				0,
				0,
			),
		);
	return c;
}

export function renderMultiCompact(d: Details, theme: Theme, now?: number): Component {
	const hasRunning =
		d.progress?.some((p) => p.status === "running") || d.results.some((r) => r.progress?.status === "running");
	const failed = d.results.some((r) => r.status === "error" && r.progress?.status !== "running");
	const hasKilled = d.results.some((r) => r.status === "killed" && r.progress?.status !== "running");
	const interrupted = d.results.some(
		(r) =>
			(r.interrupted || r.status === "interrupted" || r.status === "skipped") && r.progress?.status !== "running",
	);
	const continued = d.results.some(
		(r) => (r.detached || r.status === "continued") && r.progress?.status !== "running",
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
	const stats = statJoin(theme, [
		multiLabel.headerLabel,
		!hasRunning && hasKilled ? theme.fg("warning", "killed (non-resumable)") : "",
		formatProgressStats(theme, totalSummary, true, now),
	]);
	// A child that continued on its own still runs; one that was killed, interrupted or skipped was stopped.
	const glyph = markText(
		theme,
		hasRunning
			? TASK_MARKS.running
			: failed
				? TASK_MARKS.failed
				: hasKilled || interrupted
					? TASK_MARKS.stopped
					: continued
						? TASK_MARKS.running
						: TASK_MARKS.done,
	);
	const c = new Container();
	const width = getTermWidth() - 4;
	c.addChild(
		new Text(
			truncLine(
				`${glyph} ${theme.fg("toolTitle", theme.bold(d.mode))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
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
				const runningBadge = modelThinkingBadge(theme, runningProg.model, runningProg.thinking);
				const runningLine = `${markText(theme, TASK_MARKS.running)} ${rowLabel}: ${themeBold(theme, agentName)}${runningBadge}${runningStats ? ` ${theme.fg("dim", "·")} ${runningStats}` : ""}`;
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
			c.addChild(
				new Text(
					truncLine(
						`  ${markText(theme, TASK_MARKS.queued)} ${theme.fg("dim", `${rowLabel}: ${agentName} · pending`)}`,
						width,
					),
					0,
					0,
				),
			);
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
		const modelDisplay = modelThinkingBadge(theme, r.model ?? rProg?.model, r.thinking ?? rProg?.thinking);
		const glyph = rPending ? markText(theme, TASK_MARKS.queued) : resultGlyph(r, output, theme, rRunning);
		const pendingLabel = rPending ? ` ${theme.fg("dim", "· pending")}` : "";
		const stepLabel = resultRowLabel(d, multiLabel, i, stepNumber);
		const line = `${glyph} ${stepLabel}: ${themeBold(theme, agentName)}${modelDisplay}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}${pendingLabel}`;
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
