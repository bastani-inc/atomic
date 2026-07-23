import type { AgentSessionEvent } from "./interactive-mode-deps.ts";
import { CountdownTimer, Loader, theme } from "./interactive-mode-deps.ts";
import type { InteractiveModeBase } from "./interactive-mode-base.ts";

type RetryEvent = Extract<AgentSessionEvent, { type: `summarization_retry_${string}` }>;
const activeSources = new WeakMap<InteractiveModeBase, "branchSummary" | "compaction">();

export function handleSummarizationRetryEvent(mode: InteractiveModeBase, event: RetryEvent): void {
	if (event.type === "summarization_retry_scheduled") {
		mode.showError(event.errorMessage);
		mode.statusContainer.clear();
		mode.autoCompactionLoader?.stop();
		mode.autoCompactionLoader = undefined;
		mode.retryCountdown?.dispose();
		const retryMessage = (seconds: number) => `Retrying summary (${event.attempt}/${event.maxAttempts}) in ${seconds}s...`;
		mode.retryLoader = new Loader(mode.ui, (spinner) => theme.fg("warning", spinner), (text) => theme.fg("muted", text), retryMessage(Math.ceil(event.delayMs / 1000)));
		mode.retryCountdown = new CountdownTimer(event.delayMs, mode.ui, (seconds) => mode.retryLoader?.setMessage(retryMessage(seconds)), () => { mode.retryCountdown = undefined; });
		mode.statusContainer.addChild(mode.retryLoader);
	} else if (event.type === "summarization_retry_attempt_start") {
		activeSources.set(mode, event.source);
		mode.retryCountdown?.dispose();
		mode.retryCountdown = undefined;
		mode.retryLoader?.stop();
		mode.retryLoader = undefined;
		mode.statusContainer.clear();
		const message = event.source === "branchSummary" ? "Summarizing branch..." : event.reason === "manual" ? "Compacting context..." : "Auto-compacting...";
		mode.autoCompactionLoader = new Loader(mode.ui, (spinner) => theme.fg("accent", spinner), (text) => theme.fg("muted", text), message);
		mode.statusContainer.addChild(mode.autoCompactionLoader);
	} else {
		mode.retryCountdown?.dispose();
		mode.retryCountdown = undefined;
		mode.retryLoader?.stop();
		mode.retryLoader = undefined;
		if (activeSources.get(mode) === "branchSummary") {
			mode.autoCompactionLoader?.stop();
			mode.autoCompactionLoader = undefined;
			mode.statusContainer.clear();
		}
		activeSources.delete(mode);
	}
	mode.ui.requestRender();
}
