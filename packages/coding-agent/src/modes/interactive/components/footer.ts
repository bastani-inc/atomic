import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import {
  formatCodexFastModeModelLabel,
  shouldApplyCodexFastMode,
} from "../../../core/codex-fast-mode.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";

export type FooterSession = Pick<
  AgentSession,
  | "state"
  | "sessionManager"
  | "settingsManager"
  | "modelRegistry"
  | "getContextUsage"
  | "isStreaming"
  | "orchestrationContext"
> & {
  getRewindFooterStatus?: () => string | undefined;
};

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

function getUsageLine(
  session: FooterSession,
  autoCompactEnabled: boolean,
  width: number,
): string {
  const state = session.state;

  // Calculate cumulative usage from ALL session entries (not just post-compaction messages)
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;
  let latestCacheHitRate: number | undefined;

  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      totalInput += entry.message.usage.input;
      totalOutput += entry.message.usage.output;
      totalCacheRead += entry.message.usage.cacheRead;
      totalCacheWrite += entry.message.usage.cacheWrite;
      totalCost += entry.message.usage.cost.total;

      const latestPromptTokens =
        entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
      latestCacheHitRate = latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
    }
  }

  // Calculate context usage from session (handles compaction correctly).
  // After compaction, tokens are unknown until the next LLM response.
  const contextUsage = session.getContextUsage();
  const contextWindow =
    contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
  const contextPercentValue = contextUsage?.percent ?? 0;
  const contextPercent =
    contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

  const usageParts = [];
  if (totalInput)
    usageParts.push(
      `${theme.fg("dim", "↑")}${theme.fg("muted", formatTokens(totalInput))}`,
    );
  if (totalOutput)
    usageParts.push(
      `${theme.fg("dim", "↓")}${theme.fg("muted", formatTokens(totalOutput))}`,
    );
  if (totalCacheRead)
    usageParts.push(
      `${theme.fg("dim", "R")}${theme.fg("muted", formatTokens(totalCacheRead))}`,
    );
  if (totalCacheWrite)
    usageParts.push(
      `${theme.fg("dim", "W")}${theme.fg("muted", formatTokens(totalCacheWrite))}`,
    );
  if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined) {
    usageParts.push(`${theme.fg("dim", "CH")}${theme.fg("muted", `${latestCacheHitRate.toFixed(1)}%`)}`);
  }

  // Show cost with "(sub)" indicator if using OAuth subscription
  const usingSubscription = state.model
    ? session.modelRegistry.isUsingOAuth(state.model)
    : false;
  if (totalCost || usingSubscription) {
    usageParts.push(
      `${theme.fg("muted", `$${totalCost.toFixed(3)}`)}${usingSubscription ? ` ${theme.fg("dim", "(sub)")}` : ""}`,
    );
  }

  const autoIndicator = autoCompactEnabled ? " (auto)" : "";
  const contextPercentDisplay =
    contextPercent === "?"
      ? `?/${formatTokens(contextWindow)}${autoIndicator}`
      : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
  if (!autoCompactEnabled && contextPercentValue > 90) {
    usageParts.push(theme.fg("error", contextPercentDisplay));
  } else if (contextPercentValue > 70) {
    usageParts.push(theme.fg("warning", contextPercentDisplay));
  } else {
    usageParts.push(theme.fg("muted", contextPercentDisplay));
  }

  const separator = theme.fg("dim", " • ");
  const usageText =
    usageParts.length > 0
      ? usageParts.join(separator)
      : theme.fg("muted", contextPercentDisplay);
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

  declare private session: FooterSession;

  constructor(session: FooterSession) {
    this.session = session;
	}

  setSession(session: FooterSession): void {
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
  declare private session: FooterSession;
  declare private footerData: ReadonlyFooterDataProvider;

  constructor(
    session: FooterSession,
    footerData: ReadonlyFooterDataProvider,
  ) {
    this.session = session;
    this.footerData = footerData;
	}

  setSession(session: FooterSession): void {
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

  /**
   * Clean up resources.
   * Git watcher cleanup now handled by provider.
   */
  dispose(): void {
    // Git watcher cleanup handled by provider
  }

  render(width: number): string[] {
    const state = this.session.state;
    const pwd = replaceHome(this.session.sessionManager.getCwd());

    const modelName = state.model?.id || "no-model";
    const fastModeSettings = this.session.settingsManager.getCodexFastModeSettings();
    const fastModeEnabled = state.model
      ? shouldApplyCodexFastMode(
          state.model,
          fastModeSettings,
          this.session.orchestrationContext,
        )
      : false;
    let modelLabel = modelName;
    if (state.model?.reasoning) {
      const thinkingLevel = state.thinkingLevel || "off";
      modelLabel =
        thinkingLevel === "off" ? modelLabel : `${modelLabel} ${thinkingLevel}`;
    }
    modelLabel = formatCodexFastModeModelLabel(modelLabel, fastModeEnabled);
    if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
      modelLabel = `(${state.model.provider}) ${modelLabel}`;
    }

    const liveState = this.session.isStreaming
      ? theme.fg("muted", "esc to interrupt")
      : undefined;
    const statusParts = [theme.fg("dim", modelLabel), theme.fg("muted", pwd)];
    const rewindStatus = this.session.getRewindFooterStatus?.();
    if (rewindStatus) {
      statusParts.push(theme.fg("muted", rewindStatus));
    }
    const idleStatus = statusParts.join(` ${theme.fg("dim", "•")} `);
    const statusText = liveState ?? idleStatus;
    return [truncateToWidth(statusText, width, theme.fg("dim", "..."))];
  }
}
