import { AtomicWorkingLoader } from "./components/atomic-working-status.ts";
import { retryCancelHint, retryWaitFromEvent, retryWaitMessage } from "./components/retry-status-line.ts";
import { compactionMeta } from "./components/working-run-meter.ts";
import type { InteractiveModeBase } from "./interactive-mode-base.ts";
import type { AgentSessionEvent } from "./interactive-mode-deps.ts";
import { CountdownTimer, keyText, theme } from "./interactive-mode-deps.ts";

type RetryEvent = Extract<AgentSessionEvent, { type: `summarization_retry_${string}` }>;
const activeSources = new WeakMap<InteractiveModeBase, "branchSummary" | "compaction">();
/** Modes whose Esc cancels the summary they wait on, so a retry of it names the key. */
const cancellableSummaries = new WeakSet<InteractiveModeBase>();

/** Esc cancels the summary `mode` makes until this is called again with `false`. */
export function setSummaryCancellable(mode: InteractiveModeBase, cancellable: boolean): void {
	if (cancellable) cancellableSummaries.add(mode);
	else cancellableSummaries.delete(mode);
}

export function handleSummarizationRetryEvent(mode: InteractiveModeBase, event: RetryEvent): void {
	if (event.type === "summarization_retry_scheduled") {
		mode.showError(event.errorMessage);
		mode.statusContainer.clear();
		mode.autoCompactionLoader?.stop();
		mode.autoCompactionLoader = undefined;
		mode.retryCountdown?.dispose();
		const wait = retryWaitFromEvent(event, "summary");
		const cancel = cancellableSummaries.has(mode) ? retryCancelHint() : undefined;
		const retryMessage = (seconds: number) => retryWaitMessage(wait, seconds, cancel);
		mode.retryLoader = new AtomicWorkingLoader(
			mode.ui,
			undefined,
			(text) => theme.fg("muted", text),
			retryMessage(Math.ceil(event.delayMs / 1000)),
		);
		mode.retryCountdown = new CountdownTimer(
			event.delayMs,
			mode.ui,
			(seconds) => mode.retryLoader?.setMessage(retryMessage(seconds)),
			() => {
				mode.retryCountdown = undefined;
			},
		);
		mode.statusContainer.addChild(mode.retryLoader);
	} else if (event.type === "summarization_retry_attempt_start") {
		activeSources.set(mode, event.source);
		mode.retryCountdown?.dispose();
		mode.retryCountdown = undefined;
		mode.retryLoader?.stop();
		mode.retryLoader = undefined;
		mode.statusContainer.clear();
		const message =
			event.source === "branchSummary"
				? "Summarizing branch..."
				: event.reason === "manual"
					? "Compacting context..."
					: "Auto-compacting...";
		mode.autoCompactionLoader = new AtomicWorkingLoader(
			mode.ui,
			undefined,
			(text) => theme.fg("muted", text),
			message,
		);
		const compactionStartedAt = mode.session.compactionStartedAt ?? Date.now();
		if (event.source !== "branchSummary") mode.autoCompactionLoader.setLogo(true);
		mode.autoCompactionLoader.setMeta(() => compactionMeta(compactionStartedAt, keyText("app.interrupt")));
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
