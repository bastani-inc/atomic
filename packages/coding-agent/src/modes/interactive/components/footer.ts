import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Usage } from "@bastani/atomic-ai/compat";
import { type Component, replaceControlCharacters, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import type { AgentSession } from "../../../core/agent-session.js";
import type { SessionStats } from "../../../core/agent-session-types.js";
import { isDebugEnabled } from "../../../core/debug.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { formatModelLabel } from "../../../core/model-label.ts";
import type { TaskElapsedClocks } from "../../../core/tasks/live-elapsed.js";
import type { ChatBoxSession } from "../../../core/tasks/supervisor.js";
import {
	addHistoryUsageToTotals,
	addUsageToTotals,
	createUsageTotals,
	type UsageTotals,
} from "../../../core/usage-totals.ts";
import { formatTokenCount } from "../../../utils/token-count.ts";
import { getEngineSessionStats } from "../../interactive-engine/engine-session-stats.js";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";
import { clickableKeyTextHint } from "./nav-keys.ts";
import { renderTaskFooter } from "./task-list.js";

export interface FooterRenderStyle {
	dim(text: string): string;
	muted(text: string): string;
	warning(text: string): string;
}

export interface FooterHints {
	segments: string[];
	/** Insert this hint only if it fits beside the already laid-out footer. */
	optionalIndex?: number;
}

type FooterHintSource = () => readonly string[] | FooterHints;

const MIN_STATUS_WIDTH = 12;

const defaultFooterRenderStyle: FooterRenderStyle = {
	dim: (text) => theme.fg("dim", text),
	muted: (text) => theme.fg("muted", text),
	warning: (text) => theme.fg("warning", text),
};

function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse
	// multiple spaces (pi parity). ANSI/SGR sequences must survive intact:
	// extension statuses are frequently theme-colored, and stripping only the
	// ESC byte would leave the rest of the sequence as visible literal text.
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * The extension status row under the footer: statuses sorted by key, joined by a dim bullet and
 * truncated to the width. Shared by the chat footer and a task page's footer.
 */
export function renderExtensionStatusRow(
	statuses: ReadonlyMap<string, string>,
	width: number,
	style: Pick<FooterRenderStyle, "dim"> = defaultFooterRenderStyle,
): string | undefined {
	if (statuses.size === 0) return undefined;
	const sorted = [...statuses].sort(([a], [b]) => a.localeCompare(b));
	return truncateToWidth(
		sorted.map(([, text]) => sanitizeStatusText(text)).join(` ${style.dim("•")} `),
		width,
		style.dim("..."),
	);
}

function replaceHome(input: string): string {
	return formatCwdForFooter(input, process.env.HOME || process.env.USERPROFILE);
}

/** A usage meter segment and its place in the order segments leave a meter too wide for the terminal. */
interface UsageSegment {
	readonly text: string;
	readonly drop: number;
}

/** Cache write leaves first, then cache read, the cache hit rate, the cost, input and output. */
const USAGE_DROP_ORDER = { cacheWrite: 0, cacheRead: 1, cacheHitRate: 2, cost: 3, input: 4, output: 5 } as const;

function rightAlign(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth >= width) {
		return truncateToWidth(line, width, theme.fg("dim", "..."));
	}
	return `${" ".repeat(width - lineWidth)}${line}`;
}

type UsageSummary = { totals: UsageTotals; latestCacheHitRate: number | undefined };

interface MirrorStats extends UsageSummary {
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	limitsModel: AgentSession["model"];
	contextUsage: ContextUsage | undefined;
}

const mirrorStats = new WeakMap<ChatBoxSession, MirrorStats>();

function getCacheHitRate(usage: Usage): number | undefined {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
}

function summarizeEngineUsage(stats: SessionStats): UsageSummary {
	const { input, output, cacheRead, cacheWrite } = stats.tokens;
	return {
		totals: { input, output, cacheRead, cacheWrite, cost: stats.cost },
		latestCacheHitRate: stats.latestAssistantUsage ? getCacheHitRate(stats.latestAssistantUsage) : undefined,
	};
}

function summarizeEntryUsage(session: ChatBoxSession): UsageSummary {
	// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
	const totals = createUsageTotals();
	const omitted = session.sessionManager.getOmittedHistoryTotals?.();
	addHistoryUsageToTotals(totals, omitted);
	let latestCacheHitRate = omitted?.latestAssistantUsage ? getCacheHitRate(omitted.latestAssistantUsage) : undefined;
	let latestAssistantSeq = omitted?.latestAssistantSeq ?? -1;

	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			addUsageToTotals(totals, entry.message.usage);
			const seq = session.sessionManager.getEntrySeq?.(entry.id) ?? Number.MAX_SAFE_INTEGER;
			if (seq >= latestAssistantSeq) {
				latestCacheHitRate = getCacheHitRate(entry.message.usage);
				latestAssistantSeq = seq;
			}
		} else if (
			(entry.type === "branch_summary" || entry.type === "session_summary" || entry.type === "compaction") &&
			entry.usage
		) {
			addUsageToTotals(totals, entry.usage);
		} else if (
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			"usage" in entry.message &&
			entry.message.usage
		) {
			addUsageToTotals(totals, entry.message.usage);
		}
	}
	return { totals, latestCacheHitRate };
}

function getMirrorStats(session: ChatBoxSession): MirrorStats {
	const manager = session.sessionManager;
	const sessionId = manager.getSessionId();
	const leafId = manager.getLeafId();
	const entryCount = manager.getEntryCount();
	const limitsModel = session.model;
	const cached = mirrorStats.get(session);
	if (
		cached &&
		cached.sessionId === sessionId &&
		cached.leafId === leafId &&
		cached.entryCount === entryCount &&
		cached.limitsModel === limitsModel
	)
		return cached;

	const { totals, latestCacheHitRate } = summarizeEntryUsage(session);
	const contextUsage = session.getContextUsage();
	const stats = { sessionId, leafId, entryCount, limitsModel, totals, latestCacheHitRate, contextUsage };
	mirrorStats.set(session, stats);
	return stats;
}

function getUsageLine(session: ChatBoxSession, autoCompactEnabled: boolean, width: number): string {
	const state = session.state;
	// An isolated engine owns the live session; its stats replace the host's mirror entries.
	const engineStats = getEngineSessionStats(session);
	const { totals, latestCacheHitRate, contextUsage } = engineStats
		? { ...summarizeEngineUsage(engineStats), contextUsage: engineStats.contextUsage }
		: getMirrorStats(session);
	const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
	const contextPercentValue = contextUsage?.percent ?? 0;
	const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

	const usageParts: UsageSegment[] = [];
	const tokenSegment = (label: string, count: number, drop: number): UsageSegment => ({
		text: `${theme.fg("dim", label)}${theme.fg("muted", formatTokenCount(count))}`,
		drop,
	});
	if (totals.input) usageParts.push(tokenSegment("↑", totals.input, USAGE_DROP_ORDER.input));
	if (totals.output) usageParts.push(tokenSegment("↓", totals.output, USAGE_DROP_ORDER.output));
	if (totals.cacheRead) usageParts.push(tokenSegment("R", totals.cacheRead, USAGE_DROP_ORDER.cacheRead));
	if (totals.cacheWrite) usageParts.push(tokenSegment("W", totals.cacheWrite, USAGE_DROP_ORDER.cacheWrite));
	if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
		usageParts.push({
			text: `${theme.fg("dim", "CH")}${theme.fg("muted", `${latestCacheHitRate.toFixed(1)}%`)}`,
			drop: USAGE_DROP_ORDER.cacheHitRate,
		});
	}

	// Kimi Coding is subscription-backed despite using API-key authentication.
	const usingSubscription = state.model
		? state.model.provider === "kimi-coding" ||
			session.modelRuntime.isUsingOAuth(state.model.provider, { refresh: false })
		: false;
	if (totals.cost || usingSubscription) {
		usageParts.push({
			text: `${theme.fg("muted", `$${totals.cost.toFixed(3)}`)}${usingSubscription ? ` ${theme.fg("dim", "(sub)")}` : ""}`,
			drop: USAGE_DROP_ORDER.cost,
		});
	}

	const autoIndicator = autoCompactEnabled ? " (auto)" : "";
	const contextPercentDisplay =
		contextPercent === "?"
			? `?/${formatTokenCount(contextWindow)}${autoIndicator}`
			: `${contextPercent}%/${formatTokenCount(contextWindow)}${autoIndicator}`;
	const context = (text: string): UsageSegment => ({ text, drop: Number.POSITIVE_INFINITY });
	if (autoCompactEnabled && contextPercentValue > 70) {
		usageParts.push(context(theme.fg("warning", contextPercentDisplay)));
	} else if (contextPercentValue > 90) {
		usageParts.push(context(theme.fg("error", contextPercentDisplay)));
	} else if (contextPercentValue > 70) {
		usageParts.push(context(theme.fg("warning", contextPercentDisplay)));
	} else {
		usageParts.push(context(theme.fg("muted", contextPercentDisplay)));
	}

	// A meter too wide for the terminal drops whole segments before it is cut, so the context usage at its end stays.
	const separator = theme.fg("dim", " • ");
	const meterWidth = () => visibleWidth(usageParts.map((part) => part.text).join(separator));
	while (meterWidth() > width) {
		const dropped = usageParts.reduce((lowest, part) => (part.drop < lowest.drop ? part : lowest));
		if (dropped.drop === Number.POSITIVE_INFINITY) break;
		usageParts.splice(usageParts.indexOf(dropped), 1);
	}
	return rightAlign(usageParts.map((part) => part.text).join(separator), width);
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Right-aligned usage meter that sits above the composer, matching the approved
 * prototype's separate token/cost/context ribbon.
 */
export class UsageMeterComponent implements Component {
	private autoCompactEnabled = true;

	private declare session: ChatBoxSession;

	constructor(session: ChatBoxSession) {
		this.session = session;
	}

	setSession(session: ChatBoxSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	invalidate(): void {
		// Render pulls live session data.
	}

	render(width: number): string[] {
		return [getUsageLine(this.session, this.autoCompactEnabled, width)];
	}
}

/** Whether a chat's agent is working: a turn (with its tool calls), a compaction, a retry's backoff or a `!` command. */
export function isChatSessionWorking(session: ChatBoxSession): boolean {
	return session.isStreaming || session.isCompacting || session.isRetrying || session.isBashRunning;
}

function sanitizeFooterSegment(text: string): string {
	return replaceControlCharacters(text).replace(/\s+/g, " ").trim();
}

/** The work of the agent the prompt writes to, when it is not the footer's session. */
export interface FooterViewedWork {
	readonly working: boolean;
	/** What the interrupt key does to it, as `<key> to <stopVerb>`: `pause` for a subagent. */
	readonly stopVerb: string;
}

export class FooterComponent implements Component {
	private declare session: ChatBoxSession;
	private declare footerData: ReadonlyFooterDataProvider;
	private declare readonly renderStyle: FooterRenderStyle;
	private readonly navigationActive: () => boolean;
	private readonly backgroundTasks: (() => Parameters<typeof renderTaskFooter>[0] | undefined) | undefined;
	private readonly hintSegments: FooterHintSource | undefined;
	private readonly backgroundTaskClocks: (() => TaskElapsedClocks | undefined) | undefined;
	private branchCwd: string | undefined;
	private releaseBranch: (() => void) | undefined;
	private disposed = false;
	/** The agent the prompt writes to when it is not this footer's session: its work and the key that stops it. */
	private viewedWork: (() => FooterViewedWork | undefined) | undefined;

	/** `backgroundTasks` supplies this chat's task view, or a single snapshot to render. */
	constructor(
		session: ChatBoxSession,
		footerData: ReadonlyFooterDataProvider,
		renderStyle: FooterRenderStyle = defaultFooterRenderStyle,
		navigationActive: () => boolean = () => false,
		backgroundTasks?: () => Parameters<typeof renderTaskFooter>[0] | undefined,
		hintSegments?: FooterHintSource,
		backgroundTaskClocks?: () => TaskElapsedClocks | undefined,
	) {
		this.session = session;
		this.footerData = footerData;
		this.renderStyle = renderStyle;
		this.navigationActive = navigationActive;
		this.backgroundTasks = backgroundTasks;
		this.hintSegments = hintSegments;
		this.backgroundTaskClocks = backgroundTaskClocks;
	}

	setSession(session: ChatBoxSession): void {
		if (this.session !== session) {
			this.releaseBranch?.();
			this.releaseBranch = undefined;
			this.branchCwd = undefined;
		}
		this.session = session;
	}

	/**
	 * While the prompt writes to another agent than this footer's session (a subagent shown on the main screen), the
	 * footer's working state and stop key are that agent's; undefined while they are the session's own.
	 */
	setViewedWork(work: (() => FooterViewedWork | undefined) | undefined): void {
		this.viewedWork = work;
	}

	setAutoCompactEnabled(_enabled: boolean): void {
		// Usage state lives in UsageMeterComponent. Kept for compatibility with existing call sites.
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/** Release this viewer's branch subscription without disposing shared footer data. */
	dispose(): void {
		this.disposed = true;
		this.releaseBranch?.();
		this.releaseBranch = undefined;
	}

	render(width: number): string[] {
		if (this.disposed) return [];
		const state = this.session.state;
		const cwd = this.session.sessionManager.getCwd();
		if (this.branchCwd !== cwd) {
			this.releaseBranch?.();
			// Repaints are requested by the host's existing shared branch subscription.
			this.releaseBranch = this.footerData.onBranchChange(() => {}, cwd);
			this.branchCwd = cwd;
		}
		let pwd = replaceHome(cwd);
		const branch = this.footerData.getGitBranch(cwd);
		if (branch) pwd += ` (${branch})`;
		pwd = sanitizeFooterSegment(pwd);
		const rawSessionName =
			typeof this.session.sessionManager.getSessionName === "function"
				? this.session.sessionManager.getSessionName()
				: undefined;
		const sessionName = rawSessionName ? sanitizeFooterSegment(rawSessionName) : "";
		if (sessionName && !this.hintSegments) pwd += ` • ${sessionName}`;

		const modelLabel = state.model
			? formatModelLabel(
					{
						...state.model,
						provider: sanitizeFooterSegment(state.model.provider),
						id: sanitizeFooterSegment(state.model.id),
					},
					{
						thinkingLevel: sanitizeFooterSegment(state.thinkingLevel || "off"),
						omitProvider: this.footerData.getAvailableProviderCount() <= 1,
					},
				)
			: "no-model";

		const viewed = this.viewedWork?.();
		const working = viewed?.working ?? isChatSessionWorking(this.session);
		const lines: string[] = [];
		if (!working || !this.navigationActive()) {
			const interruptKey = working ? keyText("app.interrupt") : "";
			let statusText = working
				? interruptKey
					? this.renderStyle.muted(clickableKeyTextHint(interruptKey, ` to ${viewed?.stopVerb ?? "interrupt"}`))
					: ""
				: `${this.renderStyle.dim(modelLabel)} ${this.renderStyle.dim("•")} ${this.renderStyle.muted(pwd)}`;
			if (areExperimentalFeaturesEnabled()) {
				statusText += `${statusText ? " " : ""}${this.renderStyle.warning("xp")}`;
			}
			if (isDebugEnabled()) {
				statusText += `${statusText ? " " : ""}${this.renderStyle.warning("debug")}`;
			}
			const hintSeparator = this.renderStyle.dim(" · ");
			const hints = this.navigationActive() ? [] : (this.hintSegments?.() ?? []);
			const segments = ("segments" in hints ? hints.segments : hints).map((text) => this.renderStyle.muted(text));
			const optionalIndex = "segments" in hints ? hints.optionalIndex : undefined;
			const kept = segments.filter((_, index) => index !== optionalIndex);
			if (statusText && kept.length > 0) {
				const required = working ? visibleWidth(statusText) : MIN_STATUS_WIDTH;
				const room = () => width - visibleWidth(hintSeparator + kept.join(hintSeparator));
				while (kept.length > 2 && room() < required) kept.splice(1, 1);
				const available = room();
				if (available < required) statusText = "";
				else if (!working) statusText = truncateToWidth(statusText, available, this.renderStyle.dim("..."));
			}
			if (!statusText) {
				while (kept.length > 1 && visibleWidth(kept.join(hintSeparator)) > width) {
					kept.splice(kept.length > 2 ? 1 : 0, 1);
				}
			}
			// Fit the optional hint around what survived, never the other way round.
			const parts = statusText ? [statusText, ...kept] : kept;
			const next =
				optionalIndex === undefined ? -1 : parts.findIndex((part) => segments.indexOf(part) > optionalIndex);
			if (parts.length === 1) parts[0] = truncateToWidth(parts[0]!, width, this.renderStyle.dim("..."));
			let line = parts.join(hintSeparator);
			if (optionalIndex !== undefined) {
				const extra = segments[optionalIndex]!;
				const candidate = parts.toSpliced(next < 0 ? parts.length : next, 0, extra).join(hintSeparator);
				if (visibleWidth(candidate) <= width) line = candidate;
			}
			if (line || parts.length > 0) lines.push(line);
		}
		const statusRow = renderExtensionStatusRow(this.footerData.getExtensionStatuses(), width, this.renderStyle);
		if (statusRow !== undefined) lines.push(statusRow);
		const tasks = this.backgroundTasks?.();
		if (tasks !== undefined) lines.push(...renderTaskFooter(tasks, width, this.backgroundTaskClocks?.()));
		return lines;
	}
}
