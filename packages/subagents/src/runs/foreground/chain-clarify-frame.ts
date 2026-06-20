import { visibleWidth } from "@earendil-works/pi-tui";
import { disposeNoticeTimer, type ChainClarifyState } from "./chain-clarify-state.ts";

export function padVisible(s: string, len: number): string {
	const vis = visibleWidth(s);
	return s + " ".repeat(Math.max(0, len - vis));
}

export function row(state: ChainClarifyState, content: string): string {
	const innerW = state.width - 2;
	return state.theme.fg("border", "│") + padVisible(content, innerW) + state.theme.fg("border", "│");
}

export function renderHeader(state: ChainClarifyState, text: string): string {
	const innerW = state.width - 2;
	const padLen = Math.max(0, innerW - visibleWidth(text));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		state.theme.fg("border", "╭" + "─".repeat(padLeft)) +
		state.theme.fg("accent", text) +
		state.theme.fg("border", "─".repeat(padRight) + "╮")
	);
}

export function renderFooter(state: ChainClarifyState, text: string): string {
	const innerW = state.width - 2;
	const padLen = Math.max(0, innerW - visibleWidth(text));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		state.theme.fg("border", "╰" + "─".repeat(padLeft)) +
		state.theme.fg("dim", text) +
		state.theme.fg("border", "─".repeat(padRight) + "╯")
	);
}

export function getStepLabel(state: ChainClarifyState, stepIndex: number): string {
	const agentName = state.agentConfigs[stepIndex]?.name ?? "unknown";
	if (state.mode === "single") return agentName;
	if (state.mode === "parallel") return `Task ${stepIndex + 1}: ${agentName}`;
	return `Step ${stepIndex + 1}: ${agentName}`;
}

export function getFooterText(state: ChainClarifyState): string {
	const bgLabel = state.runInBackground ? "[b]g:ON" : "[b]g";
	switch (state.mode) {
		case "single":
			return ` [Enter] Run • [Esc] Cancel • e m t w s ${bgLabel} `;
		case "parallel":
			return ` [Enter] Run • [Esc] Cancel • e m t s ${bgLabel} • ↑↓ Nav `;
		case "chain":
			return ` [Enter] Run • [Esc] Cancel • e m t w r p s ${bgLabel} • ↑↓ Nav `;
	}
}

export function appendNotice(state: ChainClarifyState, lines: string[]): void {
	if (!state.noticeMessage) return;
	const color = state.noticeMessage.type === "error" ? "error" : "success";
	lines.push(row(state, ` ${state.theme.fg(color, state.noticeMessage.text)}`));
}

export function showNotice(state: ChainClarifyState, text: string, type: "info" | "error"): void {
	state.noticeMessage = { text, type };
	disposeNoticeTimer(state);
	state.noticeMessageTimer = setTimeout(() => {
		state.noticeMessage = null;
		state.noticeMessageTimer = null;
		state.tui.requestRender();
	}, 2000);
	state.tui.requestRender();
}
