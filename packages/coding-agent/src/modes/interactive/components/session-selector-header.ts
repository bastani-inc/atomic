import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import type { NameFilter, SortMode } from "./session-selector-search.ts";
import type { SessionScope } from "./session-selector-types.ts";

export class SessionSelectorHeader implements Component {
	private scope: SessionScope;
	private sortMode: SortMode;
	private nameFilter: NameFilter;
	private requestRender: () => void;
	private loading = false;
	private loadProgress: { loaded: number; total: number } | null = null;
	private showPath = false;
	private confirmingDeletePath: string | null = null;
	private statusMessage: { type: "info" | "error"; message: string } | null = null;
	private statusTimeout: ReturnType<typeof setTimeout> | null = null;
	private showRenameHint = false;

	constructor(scope: SessionScope, sortMode: SortMode, nameFilter: NameFilter, requestRender: () => void) {
		this.scope = scope;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.requestRender = requestRender;
	}

	setScope(scope: SessionScope): void {
		this.scope = scope;
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
	}

	setLoading(loading: boolean): void {
		this.loading = loading;
		// Progress is scoped to the current load; clear whenever the loading state is set
		this.loadProgress = null;
	}

	setProgress(loaded: number, total: number): void {
		this.loadProgress = { loaded, total };
	}

	setShowPath(showPath: boolean): void {
		this.showPath = showPath;
	}

	setShowRenameHint(show: boolean): void {
		this.showRenameHint = show;
	}

	setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
	}

	private clearStatusTimeout(): void {
		if (!this.statusTimeout) return;
		clearTimeout(this.statusTimeout);
		this.statusTimeout = null;
	}

	setStatusMessage(msg: { type: "info" | "error"; message: string } | null, autoHideMs?: number): void {
		this.clearStatusTimeout();
		this.statusMessage = msg;
		if (!msg || !autoHideMs) return;

		this.statusTimeout = setTimeout(() => {
			this.statusMessage = null;
			this.statusTimeout = null;
			this.requestRender();
		}, autoHideMs);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const title = this.scope === "current" ? "Resume Session (Current Folder)" : "Resume Session (All)";
		const leftText = theme.bold(title);

		const sortLabel = this.sortMode === "threaded" ? "Threaded" : this.sortMode === "recent" ? "Recent" : "Fuzzy";
		const sortText = theme.fg("muted", "Sort: ") + theme.fg("accent", sortLabel);

		const nameLabel = this.nameFilter === "all" ? "All" : "Named";
		const nameText = theme.fg("muted", "Name: ") + theme.fg("accent", nameLabel);

		let scopeText: string;
		if (this.loading) {
			const progressText = this.loadProgress ? `${this.loadProgress.loaded}/${this.loadProgress.total}` : "...";
			scopeText = `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", `Loading ${progressText}`)}`;
		} else if (this.scope === "current") {
			scopeText = `${theme.fg("accent", "◉ Current Folder")}${theme.fg("muted", " | ○ All")}`;
		} else {
			scopeText = `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", "◉ All")}`;
		}

		const rightText = truncateToWidth(`${scopeText}  ${nameText}  ${sortText}`, width, "");
		const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
		const left = truncateToWidth(leftText, availableLeft, "");
		const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));

		// Build hint lines - changes based on state (all branches truncate to width)
		let hintLine1: string;
		let hintLine2: string;
		if (this.confirmingDeletePath !== null) {
			const confirmHint = `Delete session? ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`;
			hintLine1 = theme.fg("error", truncateToWidth(confirmHint, width, "…"));
			hintLine2 = "";
		} else if (this.statusMessage) {
			const color = this.statusMessage.type === "error" ? "error" : "accent";
			hintLine1 = theme.fg(color, truncateToWidth(this.statusMessage.message, width, "…"));
			hintLine2 = "";
		} else {
			const pathState = this.showPath ? "(on)" : "(off)";
			const sep = theme.fg("muted", " · ");
			const hint1 =
				keyHint("tui.input.tab", "scope") + sep + theme.fg("muted", 're:<pattern> regex · "phrase" exact');
			const hint2Parts = [
				keyHint("app.session.toggleSort", "Sort"),
				keyHint("app.session.toggleNamedFilter", "Named"),
				keyHint("app.session.delete", "Delete"),
				keyHint("app.session.togglePath", `Path ${pathState}`),
			];
			if (this.showRenameHint) {
				hint2Parts.push(keyHint("app.session.rename", "Rename"));
			}
			const hint2 = hint2Parts.join(sep);
			hintLine1 = truncateToWidth(hint1, width, "…");
			hintLine2 = truncateToWidth(hint2, width, "…");
		}

		return [`${left}${" ".repeat(spacing)}${rightText}`, hintLine1, hintLine2];
	}
}
