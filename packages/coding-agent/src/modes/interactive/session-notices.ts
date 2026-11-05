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
export function showSessionNotices(view: SessionNoticeView, notices: readonly SessionNotice[]): void {
	for (const notice of notices) {
		if (notice.type === "error") view.showError(notice.message);
		else if (notice.type === "warning") view.showWarning(notice.message);
		else view.showStatus(notice.message, true);
	}
}
