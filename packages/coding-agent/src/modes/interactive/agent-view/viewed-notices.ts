import type { InteractiveModeBase } from "../interactive-mode-base.ts";

export type ViewedNoticeKind = "info" | "warning" | "error";

/** Where notices about the shown subagent are drawn: under its transcript. */
export interface ViewedNoticeSink {
	show(text: string, kind: ViewedNoticeKind): void;
}

const sinks = new WeakMap<InteractiveModeBase, ViewedNoticeSink>();

/** Set by the transcript area while it can draw notices under a subagent's transcript. */
export function setViewedNoticeSink(mode: InteractiveModeBase, sink: ViewedNoticeSink | undefined): void {
	if (sink === undefined) sinks.delete(mode);
	else sinks.set(mode, sink);
}

/**
 * A notice about the shown subagent and nothing else, such as a refused command: drawn under its transcript and
 * kept out of the main chat. With main shown, or nowhere to draw it, it is the main chat's notice. A notice that
 * carries text the reader typed, or that the main chat must keep, goes through the main chat's own notices instead.
 */
export function notifyViewed(mode: InteractiveModeBase, text: string, kind: ViewedNoticeKind): void {
	const sink = sinks.get(mode);
	if (sink !== undefined && mode.agentView?.viewed.kind === "agent") {
		sink.show(text, kind);
		return;
	}
	if (kind === "error") mode.showError(text);
	else if (kind === "warning") mode.showWarning(text);
	else mode.showStatus(text);
}
