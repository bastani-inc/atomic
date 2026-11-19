import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.js";
import type { InteractiveModeBase } from "./interactive-mode-base.ts";
import { Spacer, Text, theme } from "./interactive-mode-deps.ts";

function renderLegacyWorkflowNotice(mode: InteractiveModeBase, count: number | undefined): void {
	if (!count || !mode.shouldShowStartupDetails()) return;
	mode.startupNoticesContainer.addChild(new Spacer(1));
	mode.startupNoticesContainer.addChild(
		new Text(
			theme.fg(
				"dim",
				`Found ${count} legacy workflow file${count === 1 ? "" : "s"}. Ask Atomic to convert ${count === 1 ? "it into a skill" : "them into skills"} for use with codemode and subagents.`,
			),
			1,
			0,
		),
	);
	mode.ui.requestRender();
}

/** Only the engine knows the final trust decisions and which temporary packages the user supplied. */
export function showLegacyWorkflowNotice(mode: InteractiveModeBase): void {
	if (mode.runtimeHost instanceof IsolatedInteractiveRuntime) {
		const session = mode.session;
		void mode.runtimeHost.getStartupLegacyWorkflowFileCount().then(
			(count) => {
				if (!mode.isShuttingDown && mode.session === session) renderLegacyWorkflowNotice(mode, count);
			},
			() => {
				/* The engine reports resource readiness failures separately. */
			},
		);
	} else {
		renderLegacyWorkflowNotice(mode, mode.session.resourceLoader?.getLegacyWorkflowFiles?.()?.total);
	}
}

export interface SessionNotice {
	readonly type: "info" | "warning" | "error";
	readonly message: string;
}

export interface SessionNoticeView {
	showError(message: string): void;
	showWarning(message: string): void;
	showStatus(message: string, persist?: boolean): void;
}

/** Shows each notice on its own line; an informational one stays in the chat when the next status arrives. */
export function showSessionNotices(view: SessionNoticeView, notices: readonly SessionNotice[] | undefined): void {
	for (const notice of notices ?? []) {
		if (notice.type === "error") view.showError(notice.message);
		else if (notice.type === "warning") view.showWarning(notice.message);
		else view.showStatus(notice.message, true);
	}
}
