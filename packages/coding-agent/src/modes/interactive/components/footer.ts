import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Usage } from "@bastani/pi-ai/compat";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.js";
import type { SessionStats } from "../../../core/agent-session-types.js";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { getOwnerTaskStore } from "../../../core/tasks/owner-store.js";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { getEngineSessionStats } from "../../interactive-engine/engine-session-stats.ts";
import { theme } from "../theme/theme.js";
import { renderTaskFooter } from "./task-list.js";

export interface FooterRenderStyle {
	dim(text: string): string;
	muted(text: string): string;
	warning(text: string): string;
}

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
 * Format token counts (similar to web-ui)
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function replaceHome(input: string): string {
	return formatCwdForFooter(input, process.env.HOME || process.env.USERPROFILE);
}

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

const mirrorStats = new WeakMap<AgentSession, MirrorStats>();

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

function summarizeEntryUsage(session: AgentSession): UsageSummary {
	// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
	const totals = createUsageTotals();
	let latestCacheHitRate: number | undefined;

	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			addUsageToTotals(totals, entry.message.usage);
			latestCacheHitRate = getCacheHitRate(entry.message.usage);
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

function getMirrorStats(session: AgentSession): MirrorStats {
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

function getUsageLine(session: AgentSession, autoCompactEnabled: boolean, width: number): string {
	const state = session.state;
	// An isolated engine owns the live session; its stats replace the host's mirror entries.
	const engineStats = getEngineSessionStats(session);
	const { totals, latestCacheHitRate, contextUsage } = engineStats
		? { ...summarizeEngineUsage(engineStats), contextUsage: engineStats.contextUsage }
		: getMirrorStats(session);
	const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
	const contextPercentValue = contextUsage?.percent ?? 0;
	const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

	const usageParts = [];
	if (totals.input) usageParts.push(`${theme.fg("dim", "↑")}${theme.fg("muted", formatTokens(totals.input))}`);
	if (totals.output) usageParts.push(`${theme.fg("dim", "↓")}${theme.fg("muted", formatTokens(totals.output))}`);
	if (totals.cacheRead) usageParts.push(`${theme.fg("dim", "R")}${theme.fg("muted", formatTokens(totals.cacheRead))}`);
	if (totals.cacheWrite)
		usageParts.push(`${theme.fg("dim", "W")}${theme.fg("muted", formatTokens(totals.cacheWrite))}`);
	if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
		usageParts.push(`${theme.fg("dim", "CH")}${theme.fg("muted", `${latestCacheHitRate.toFixed(1)}%`)}`);
	}

	// Kimi Coding is subscription-backed despite using API-key authentication.
	const usingSubscription = state.model
		? state.model.provider === "kimi-coding" || session.modelRuntime.isUsingOAuth(state.model.provider)
		: false;
	if (totals.cost || usingSubscription) {
		usageParts.push(
			`${theme.fg("muted", `$${totals.cost.toFixed(3)}`)}${usingSubscription ? ` ${theme.fg("dim", "(sub)")}` : ""}`,
		);
	}

	const autoIndicator = autoCompactEnabled ? " (auto)" : "";
	const contextPercentDisplay =
		contextPercent === "?"
			? `?/${formatTokens(contextWindow)}${autoIndicator}`
			: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
	if (autoCompactEnabled && contextPercentValue > 70) {
		usageParts.push(theme.fg("warning", contextPercentDisplay));
	} else if (contextPercentValue > 90) {
		usageParts.push(theme.fg("error", contextPercentDisplay));
	} else if (contextPercentValue > 70) {
		usageParts.push(theme.fg("warning", contextPercentDisplay));
	} else {
		usageParts.push(theme.fg("muted", contextPercentDisplay));
	}

	const separator = theme.fg("dim", " • ");
	const usageText = usageParts.length > 0 ? usageParts.join(separator) : theme.fg("muted", contextPercentDisplay);
	return rightAlign(usageText, width);
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

	private declare session: AgentSession;

	constructor(session: AgentSession) {
		this.session = session;
	}

	setSession(session: AgentSession): void {
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

/**
 * Sparse statusline below the composer. It mirrors the preview: model + cwd
 * when idle, or one semantic dot with short recovery copy while work is live.
 */
export class FooterComponent implements Component {
	private declare session: AgentSession;
	private declare footerData: ReadonlyFooterDataProvider;
	private declare readonly renderStyle: FooterRenderStyle;
	private readonly navigationActive: () => boolean;
	private branchCwd: string | undefined;
	private releaseBranch: (() => void) | undefined;
	private disposed = false;

	constructor(
		session: AgentSession,
		footerData: ReadonlyFooterDataProvider,
		renderStyle: FooterRenderStyle = defaultFooterRenderStyle,
		navigationActive: () => boolean = () => false,
	) {
		this.session = session;
		this.footerData = footerData;
		this.renderStyle = renderStyle;
		this.navigationActive = navigationActive;
	}

	setSession(session: AgentSession): void {
		if (this.session !== session) {
			this.releaseBranch?.();
			this.releaseBranch = undefined;
			this.branchCwd = undefined;
		}
		this.session = session;
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
		const sessionName =
			typeof this.session.sessionManager.getSessionName === "function"
				? this.session.sessionManager.getSessionName()
				: undefined;
		if (sessionName) pwd += ` • ${sessionName}`;

		const modelName = state.model?.id || "no-model";
		let modelLabel = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			modelLabel = thinkingLevel === "off" ? modelLabel : `${modelLabel} ${thinkingLevel}`;
		}
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			modelLabel = `(${state.model.provider}) ${modelLabel}`;
		}

		const liveState =
			this.session.isStreaming && !this.navigationActive() ? this.renderStyle.muted("esc to interrupt") : undefined;
		let statusText =
			liveState ?? `${this.renderStyle.dim(modelLabel)} ${this.renderStyle.dim("•")} ${this.renderStyle.muted(pwd)}`;
		if (areExperimentalFeaturesEnabled()) statusText += ` ${this.renderStyle.warning("xp")}`;
		const lines = [truncateToWidth(statusText, width, this.renderStyle.dim("..."))];
		const statuses = [...this.footerData.getExtensionStatuses()].sort(([a], [b]) => a.localeCompare(b));
		if (statuses.length > 0) {
			lines.push(
				truncateToWidth(
					statuses.map(([, text]) => sanitizeStatusText(text)).join(` ${this.renderStyle.dim("•")} `),
					width,
					this.renderStyle.dim("..."),
				),
			);
		}
		lines.push(...renderTaskFooter(getOwnerTaskStore(this.session)?.backgroundTasks ?? [], width));
		return lines;
	}
}
