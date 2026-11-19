import { type Component, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import { theme } from "../theme/theme.js";
import type { SessionListNotice, SessionListVariant } from "./session-selector-list.ts";
import type { NameFilter, SortMode } from "./session-selector-search.ts";
import type { SessionScope } from "./session-selector-types.ts";

function fitHeaderText(text: string, room: number): string {
	return visibleWidth(text) <= room ? text : truncateToWidth(text, room, "…");
}

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
	private variant: SessionListVariant = "sessions";
	private title?: string;

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

	setVariant(variant: SessionListVariant): void {
		this.variant = variant;
	}

	setTitle(title: string | undefined): void {
		this.title = title;
	}

	/** The line under the list: the pending delete question, else a transient status. */
	getNotice(): SessionListNotice | undefined {
		if (this.confirmingDeletePath !== null) {
			const target = this.variant === "runs" ? "this run" : "this session";
			return { text: `Delete ${target}?`, tone: "error" };
		}
		if (this.statusMessage) {
			return { text: this.statusMessage.message, tone: this.statusMessage.type === "error" ? "error" : "accent" };
		}
		return undefined;
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 3);
		const title =
			this.title ??
			(this.variant === "runs" ? "Resume run" : this.variant === "mixed" ? "Resume" : "Resume session");
		const facts: string[] = [];
		const hasSessions = this.variant === "sessions" || this.variant === "mixed";
		if (hasSessions) facts.push(this.scope === "current" ? "this folder" : "all folders");
		if (hasSessions || this.sortMode !== "threaded") {
			facts.push(
				this.sortMode === "threaded"
					? "threaded"
					: this.sortMode === "recent"
						? "most recent first"
						: "best match first",
			);
		}
		if (hasSessions && this.nameFilter === "named") facts.push("named only");
		if (hasSessions && this.showPath) facts.push("showing paths");
		if (this.loading) {
			facts.push(this.loadProgress ? `Loading ${this.loadProgress.loaded}/${this.loadProgress.total}` : "Loading…");
		}
		const lines = [`  ${theme.bold(theme.fg("text", fitHeaderText(title, inner)))}`];
		if (facts.length > 0) lines.push(`  ${theme.fg("muted", fitHeaderText(facts.join(" · "), inner))}`);
		lines.push(
			`  ${theme.fg("dim", fitHeaderText('re:<pattern> for a regex · "phrase" for an exact match', inner))}`,
		);
		return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
	}
}
