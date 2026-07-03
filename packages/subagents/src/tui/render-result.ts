import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, keyHint } from "@bastani/atomic";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import type { AgentProgress, AsyncJobStep, Details } from "../shared/types.ts";
import { formatDuration, formatTokens, formatUsage, shortenPath } from "../shared/formatters.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import { getTermWidth, truncLine, type Theme } from "./render-layout.ts";
import { advanceResultPulseFrame, clearResultAnimationTimer, type ResultAnimationContext } from "./render-result-animation.ts";
import { renderMultiCompact, renderSingleCompact } from "./render-result-compact.ts";
import { buildChainRenderEntries, buildMultiProgressLabel, resultRowLabel, workflowGraphHasStatus, type ChainRenderEntry } from "./render-chain-graph.ts";
import { subagentResultRenderKey } from "./render-stable-output.ts";
import { modelThinkingBadge, widgetStepStatus } from "./render-event-formatting.ts";
import {
	buildLiveStatusLine,
	displayProgressDurationMs,
	extractOutputTarget,
	formatCurrentToolLine,
	getToolCallLines,
	hasEmptyTextOutputWithoutOutputTarget,
	snapshotNowForProgress,
} from "./render-status-progress.ts";

export function renderLiveSubagentResult(
	result: AgentToolResult<Details>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: ResultAnimationContext,
): Component {
	const nextKey = subagentResultRenderKey(result, options);
	if (context.state.subagentResultSnapshotKey !== nextKey) {
		context.state.subagentResultSnapshotKey = nextKey;
		context.state.subagentResultSnapshotNow = Date.now();
		// Advance the activity pulse exactly once per real progress update.
		// Foreground subagent results render into chat scrollback, which can sit
		// above the viewport fold. Animating on a timer there forces pi-tui into a
		// destructive full-screen/scrollback clear on every tick (the flicker that
		// scaled with widget height). Driving the pulse off genuine updates keeps
		// the only line diffs tied to content that actually changed, so the
		// differential renderer repaints exactly as it would for any progress
		// update — no extra above-fold churn between updates.
		context.state.subagentResultPulseFrame = advanceResultPulseFrame(context.state.subagentResultPulseFrame);
	}
	context.state.subagentResultSnapshotNow ??= Date.now();
	context.state.subagentResultPulseFrame ??= 0;
	// Never schedule timer-driven re-renders for scrollback content; clear any
	// stale timer a previous version may have installed for this render slot.
	clearResultAnimationTimer(context);
	return renderSubagentResult(result, {
		...options,
		now: context.state.subagentResultSnapshotNow,
		pulseFrame: context.state.subagentResultPulseFrame,
	}, theme);
}

/**
 * Render a subagent result
 */
export function renderSubagentResult(
	result: AgentToolResult<Details>,
	options: { expanded: boolean; now?: number; pulseFrame?: number },
	theme: Theme,
): Component {
	const d = result.details;
	if (!d || !d.results.length) {
		const t = result.content[0];
		const text = t?.type === "text" ? t.text : "(no output)";
		const contextPrefix = d?.context === "fork" ? `${theme.fg("warning", "[fork]")} ` : "";
		return new Text(truncLine(`${contextPrefix}${text}`, getTermWidth() - 4), 0, 0);
	}

	const expanded = options.expanded;
	const mdTheme = getMarkdownTheme();

	if (d.mode === "single" && d.results.length === 1) {
		const r = d.results[0];
		if (!expanded) return renderSingleCompact(d, r, theme, options.now, options.pulseFrame);
		const isRunning = r.progress?.status === "running";
		const icon = isRunning
			? theme.fg("warning", "running")
			: r.detached
				? theme.fg("warning", "detached")
				: r.exitCode === 0
					? theme.fg("success", "ok")
					: theme.fg("error", "failed");
		const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
		const output = r.truncation?.text || getSingleResultOutput(r);

		const progressInfo = isRunning && r.progress
			? ` | ${r.progress.toolCount} tools, ${formatTokens(r.progress.tokens)} tok, ${formatDuration(displayProgressDurationMs(r.progress, options.now))}`
			: r.progressSummary
				? ` | ${r.progressSummary.toolCount} tools, ${formatTokens(r.progressSummary.tokens)} tok, ${formatDuration(r.progressSummary.durationMs)}`
				: "";

		const w = getTermWidth() - 4;
		const fit = (text: string) => expanded ? text : truncLine(text, w);
		const toolCallLines = getToolCallLines(r, expanded);
		const c = new Container();
		c.addChild(new Text(fit(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${contextBadge}${progressInfo}`), 0, 0));
		c.addChild(new Spacer(1));
		const taskMaxLen = Math.max(20, w - 8);
		const taskPreview = expanded || r.task.length <= taskMaxLen
			? r.task
			: `${r.task.slice(0, taskMaxLen)}...`;
		c.addChild(
			new Text(fit(theme.fg("dim", `Task: ${taskPreview}`)), 0, 0),
		);
		c.addChild(new Spacer(1));

		if (isRunning && r.progress) {
			const progressSnapshotNow = snapshotNowForProgress(r.progress, options.now);
			const toolLine = formatCurrentToolLine(r.progress, w, expanded, progressSnapshotNow);
			if (toolLine) {
				c.addChild(new Text(fit(theme.fg("warning", `> ${toolLine}`)), 0, 0));
			}
			const liveStatusLine = buildLiveStatusLine(r.progress, progressSnapshotNow);
			if (liveStatusLine) {
				c.addChild(new Text(fit(theme.fg("accent", liveStatusLine)), 0, 0));
			}
			c.addChild(new Text(fit(theme.fg("accent", `Press ${keyHint("app.tools.expand", "for live detail")}`)), 0, 0));
			if (r.artifactPaths) {
				c.addChild(new Text(fit(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
			}
			if (r.progress.recentTools?.length) {
				for (const t of r.progress.recentTools.slice(-3)) {
					const maxArgsLen = Math.max(40, w - 24);
					const argsPreview = expanded || t.args.length <= maxArgsLen
						? t.args
						: `${t.args.slice(0, maxArgsLen)}...`;
					c.addChild(new Text(fit(theme.fg("dim", `${t.tool}: ${argsPreview}`)), 0, 0));
				}
			}
			for (const line of (r.progress.recentOutput ?? []).slice(-5)) {
				c.addChild(new Text(fit(theme.fg("dim", `  ${line}`)), 0, 0));
			}
			if (toolLine || liveStatusLine || r.progress.recentTools?.length || r.progress.recentOutput?.length || r.artifactPaths) {
				c.addChild(new Spacer(1));
			}
		}

		if (expanded) {
			for (const line of toolCallLines) {
				c.addChild(new Text(fit(theme.fg("muted", line)), 0, 0));
			}
			if (toolCallLines.length) c.addChild(new Spacer(1));
		}

		if (output) c.addChild(new Markdown(output, 0, 0, mdTheme));
		c.addChild(new Spacer(1));
		if (r.skills?.length) {
			c.addChild(new Text(fit(theme.fg("dim", `Skills: ${r.skills.join(", ")}`)), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(fit(theme.fg("warning", `Warning: ${r.skillsWarning}`)), 0, 0));
		}
		if (r.attemptedModels && r.attemptedModels.length > 1) {
			c.addChild(new Text(fit(theme.fg("dim", `Fallbacks: ${r.attemptedModels.join(" → ")}`)), 0, 0));
		}
		c.addChild(new Text(fit(theme.fg("dim", formatUsage(r.usage, r.model))), 0, 0));
		if (r.sessionFile) {
			c.addChild(new Text(fit(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`)), 0, 0));
		}

		if (!isRunning && r.artifactPaths) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(fit(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
		}
		return c;
	}

	if (!expanded) return renderMultiCompact(d, theme, options.now, options.pulseFrame);

	const hasRunning = d.progress?.some((p) => p.status === "running")
		|| d.results.some((r) => r.progress?.status === "running")
		|| workflowGraphHasStatus(d, ["running"]);
	const ok = d.results.filter((r) => r.progress?.status === "completed" || (r.exitCode === 0 && r.progress?.status !== "running")).length;
	const hasEmptyWithoutTarget = d.results.some((r) =>
		r.exitCode === 0
		&& r.progress?.status !== "running"
		&& hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r)),
	);
	const hasWorkflowFailure = workflowGraphHasStatus(d, ["failed"]);
	const hasWorkflowPause = workflowGraphHasStatus(d, ["paused", "detached"]);
	const icon = hasRunning
		? theme.fg("warning", "running")
		: hasEmptyWithoutTarget
			? theme.fg("warning", "warning")
			: hasWorkflowFailure
				? theme.fg("error", "failed")
				: hasWorkflowPause
					? theme.fg("warning", "paused")
					: ok === d.results.length
						? theme.fg("success", "ok")
						: theme.fg("error", "failed");

	const totalSummary =
		d.progressSummary ||
		d.results.reduce(
			(acc, r) => {
				const prog = r.progress || r.progressSummary;
				if (prog) {
					acc.toolCount += prog.toolCount;
					acc.tokens += prog.tokens;
					acc.durationMs =
						d.mode === "chain"
							? acc.durationMs + prog.durationMs
							: Math.max(acc.durationMs, prog.durationMs);
				}
				return acc;
			},
			{ toolCount: 0, tokens: 0, durationMs: 0 },
		);

	const summaryStr =
		totalSummary.toolCount || totalSummary.tokens
			? ` | ${totalSummary.toolCount} tools, ${formatTokens(totalSummary.tokens)} tok, ${formatDuration(totalSummary.durationMs)}`
			: "";

	const modeLabel = d.mode;
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const multiLabel = buildMultiProgressLabel(d, hasRunning);
	const itemTitle = multiLabel.itemTitle;

	const chainVis = d.chainAgents?.length && !multiLabel.hasParallelInChain
		? d.chainAgents
				.map((agent, i) => {
					const result = d.results[i];
					const isFailed = result && result.exitCode !== 0 && result.progress?.status !== "running";
					const isComplete = result && result.exitCode === 0 && result.progress?.status !== "running";
					const isEmptyWithoutTarget = Boolean(result)
						&& Boolean(isComplete)
						&& hasEmptyTextOutputWithoutOutputTarget(result.task, getSingleResultOutput(result));
					const isCurrent = i === (d.currentStepIndex ?? d.results.length);
					const stepIcon = isFailed
						? theme.fg("error", "failed")
						: isEmptyWithoutTarget
							? theme.fg("warning", "warning")
							: isComplete
								? theme.fg("success", "done")
								: isCurrent && hasRunning
									? theme.fg("warning", "running")
									: theme.fg("dim", "pending");
					return `${stepIcon} ${agent}`;
				})
				.join(theme.fg("dim", " → "))
		: null;

	const w = getTermWidth() - 4;
	const fit = (text: string) => expanded ? text : truncLine(text, w);
	const c = new Container();
	c.addChild(
		new Text(
			fit(`${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))}${contextBadge} · ${multiLabel.headerLabel}${summaryStr}`),
			0,
			0,
		),
	);
	if (chainVis) {
		c.addChild(new Text(fit(`  ${chainVis}`), 0, 0));
	}

	const useResultsDirectly = multiLabel.hasParallelInChain || !d.chainAgents?.length;
	const displayStart = multiLabel.showActiveGroupOnly ? multiLabel.groupStartIndex : 0;
	const displayEnd = multiLabel.showActiveGroupOnly ? multiLabel.groupEndIndex : (useResultsDirectly ? d.results.length : d.chainAgents!.length);
	const chainEntries = buildChainRenderEntries(d, multiLabel);
	const renderEntries = chainEntries ?? Array.from({ length: displayEnd - displayStart }, (_, offset): ChainRenderEntry => {
		const i = displayStart + offset;
		const r = d.results[i];
		const rowNumber = multiLabel.showActiveGroupOnly ? (i - multiLabel.groupStartIndex + 1) : (i + 1);
		return { kind: "result", resultIndex: i, rowNumber, agentName: useResultsDirectly ? (r?.agent || `step-${rowNumber}`) : (d.chainAgents![i] || r?.agent || `step-${rowNumber}`) };
	});

	c.addChild(new Spacer(1));

	for (const entry of renderEntries) {
		if (entry.kind === "placeholder") {
			const statusLabel = widgetStepStatus(entry.status as AsyncJobStep["status"], theme);
			c.addChild(new Text(fit(`  ${statusLabel} ${entry.stepLabel}: ${theme.bold(entry.agentName)}`), 0, 0));
			c.addChild(new Text(theme.fg(entry.status === "failed" ? "error" : "dim", `    status: ${entry.status}`), 0, 0));
			if (entry.error) c.addChild(new Text(theme.fg("error", `    error: ${entry.error}`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}
		const i = entry.resultIndex;
		const r = d.results[i];
		const rowNumber = entry.rowNumber;
		const agentName = entry.agentName;

		if (!r) {
			const pendingLabel = chainEntries ? resultRowLabel(d, multiLabel, i, rowNumber) : `${itemTitle} ${rowNumber}`;
			c.addChild(new Text(fit(theme.fg("dim", `  ${pendingLabel}: ${agentName}`)), 0, 0));
			c.addChild(new Text(theme.fg("dim", `    status: pending`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}

		const progressFromArray = d.progress?.find((p) => p.index === i)
			|| d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rProg = (r.progress || progressFromArray || r.progressSummary) as AgentProgress | undefined;
		const rRunning = rProg?.status === "running";
		const stepNumber = typeof rProg?.index === "number" ? rProg.index + 1 : i + 1;

		const resultOutput = getSingleResultOutput(r);
		const statusIcon = rRunning
			? theme.fg("warning", "running")
			: r.exitCode !== 0
				? theme.fg("error", "failed")
				: hasEmptyTextOutputWithoutOutputTarget(r.task, resultOutput)
					? theme.fg("warning", "warning")
					: theme.fg("success", "done");
		const stats = rProg ? ` | ${rProg.toolCount} tools, ${formatDuration(displayProgressDurationMs(rProg, options.now))}` : "";
		const modelDisplay = modelThinkingBadge(theme, r.model, undefined, r.fastMode);
		const stepLabel = resultRowLabel(d, multiLabel, i, stepNumber);
		const stepHeader = rRunning
			? `${statusIcon} ${stepLabel}: ${theme.bold(theme.fg("warning", r.agent))}${modelDisplay}${stats}`
			: `${statusIcon} ${stepLabel}: ${theme.bold(r.agent)}${modelDisplay}${stats}`;
		const toolCallLines = getToolCallLines(r, expanded);
		c.addChild(new Text(fit(stepHeader), 0, 0));

		const taskMaxLen = Math.max(20, w - 12);
		const taskPreview = expanded || r.task.length <= taskMaxLen
			? r.task
			: `${r.task.slice(0, taskMaxLen)}...`;
		c.addChild(new Text(fit(theme.fg("dim", `    task: ${taskPreview}`)), 0, 0));

		const outputTarget = extractOutputTarget(r.task);
		if (outputTarget) {
			c.addChild(new Text(fit(theme.fg("dim", `    output: ${outputTarget}`)), 0, 0));
		}

		if (r.skills?.length) {
			c.addChild(new Text(fit(theme.fg("dim", `    skills: ${r.skills.join(", ")}`)), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(fit(theme.fg("warning", `    Warning: ${r.skillsWarning}`)), 0, 0));
		}
		if (r.attemptedModels && r.attemptedModels.length > 1) {
			c.addChild(new Text(fit(theme.fg("dim", `    fallbacks: ${r.attemptedModels.join(" → ")}`)), 0, 0));
		}

		if (rRunning && rProg) {
			if (rProg.skills?.length) {
				c.addChild(new Text(fit(theme.fg("accent", `    skills: ${rProg.skills.join(", ")}`)), 0, 0));
			}
			const progressSnapshotNow = snapshotNowForProgress(rProg, options.now);
			const toolLine = formatCurrentToolLine(rProg, w, expanded, progressSnapshotNow);
			if (toolLine) {
				c.addChild(new Text(fit(theme.fg("warning", `    > ${toolLine}`)), 0, 0));
			}
			const liveStatusLine = buildLiveStatusLine(rProg, progressSnapshotNow);
			if (liveStatusLine) {
				c.addChild(new Text(fit(theme.fg("accent", `    ${liveStatusLine}`)), 0, 0));
			}
			c.addChild(new Text(fit(theme.fg("accent", `    Press ${keyHint("app.tools.expand", "for live detail")}`)), 0, 0));
			if (r.artifactPaths) {
				c.addChild(new Text(fit(theme.fg("dim", `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
			}
			if (rProg.recentTools?.length) {
				for (const t of rProg.recentTools.slice(-3)) {
					const maxArgsLen = Math.max(40, w - 30);
					const argsPreview = expanded || t.args.length <= maxArgsLen
						? t.args
						: `${t.args.slice(0, maxArgsLen)}...`;
					c.addChild(new Text(fit(theme.fg("dim", `      ${t.tool}: ${argsPreview}`)), 0, 0));
				}
			}
			const recentLines = (rProg.recentOutput ?? []).slice(-5);
			for (const line of recentLines) {
				c.addChild(new Text(fit(theme.fg("dim", `      ${line}`)), 0, 0));
			}
		}

		if (!rRunning && r.artifactPaths) {
			c.addChild(new Text(fit(theme.fg("dim", `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
		}

		if (expanded && !rRunning) {
			for (const line of toolCallLines) {
				c.addChild(new Text(fit(theme.fg("muted", `      ${line}`)), 0, 0));
			}
			if (toolCallLines.length) c.addChild(new Spacer(1));
		}

		c.addChild(new Spacer(1));
	}

	if (d.artifacts) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(fit(theme.fg("dim", `Artifacts dir: ${shortenPath(d.artifacts.dir)}`)), 0, 0));
	}
	return c;
}
