import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../../core/keybindings.ts";
import type { SessionInfo } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import { filterAndSortSessions, hasSessionName, type NameFilter, type SortMode } from "./session-selector-search.ts";
import { buildSessionTree, type FlatSessionNode, flattenSessionTree } from "./session-selector-tree.ts";
import { canonicalizePath, formatSessionDate, shortenPath } from "./session-selector-utils.ts";

/**
 * Custom session list component with multi-line items and search
 */
export class SessionList implements Component, Focusable {
	public getSelectedSessionPath(): string | undefined {
		const selected = this.filteredSessions[this.selectedIndex];
		return selected?.session.path;
	}
	private allSessions: SessionInfo[] = [];
	private filteredSessions: FlatSessionNode[] = [];
	private selectedIndex: number = 0;
	private searchInput: Input;
	private showCwd = false;
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private keybindings: KeybindingsManager;
	private showPath = false;
	private confirmingDeletePath: string | null = null;
	private currentSessionCanonicalPath?: string;
	public onSelect?: (sessionPath: string) => void;
	public onCancel?: () => void;
	public onExit: () => void = () => {};
	public onToggleScope?: () => void;
	public onToggleSort?: () => void;
	public onToggleNameFilter?: () => void;
	public onTogglePath?: (showPath: boolean) => void;
	public onDeleteConfirmationChange?: (path: string | null) => void;
	public onDeleteSession?: (sessionPath: string) => Promise<void>;
	public onRenameSession?: (sessionPath: string) => void;
	public onError?: (message: string) => void;
	private maxVisible: number = 10; // Max sessions visible (one line each)

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		sessions: SessionInfo[],
		showCwd: boolean,
		sortMode: SortMode,
		nameFilter: NameFilter,
		keybindings: KeybindingsManager,
		currentSessionFilePath?: string,
	) {
		this.allSessions = sessions;
		this.filteredSessions = [];
		this.searchInput = new Input();
		this.showCwd = showCwd;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.keybindings = keybindings;
		this.currentSessionCanonicalPath = canonicalizePath(currentSessionFilePath);
		this.filterSessions("");

		// Handle Enter in search input - select current item
		this.searchInput.onSubmit = () => {
			if (this.filteredSessions[this.selectedIndex]) {
				const selected = this.filteredSessions[this.selectedIndex];
				if (this.onSelect) {
					this.onSelect(selected.session.path);
				}
			}
		};
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
		this.filterSessions(this.searchInput.getValue());
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
		this.filterSessions(this.searchInput.getValue());
	}

	setSessions(sessions: SessionInfo[], showCwd: boolean): void {
		this.allSessions = sessions;
		this.showCwd = showCwd;
		this.filterSessions(this.searchInput.getValue());
	}

	private filterSessions(query: string): void {
		const trimmed = query.trim();
		const nameFiltered =
			this.nameFilter === "all" ? this.allSessions : this.allSessions.filter((session) => hasSessionName(session));

		if (this.sortMode === "threaded" && !trimmed) {
			// Threaded mode without search: show tree structure
			const roots = buildSessionTree(nameFiltered);
			this.filteredSessions = flattenSessionTree(roots);
		} else {
			// Other modes or with search: flat list
			const filtered = filterAndSortSessions(nameFiltered, query, this.sortMode, "all");
			this.filteredSessions = filtered.map((session) => ({
				session,
				depth: 0,
				isLast: true,
				ancestorContinues: [],
			}));
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredSessions.length - 1));
	}

	private setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
		this.onDeleteConfirmationChange?.(path);
	}

	private startDeleteConfirmationForSelectedSession(): void {
		const selected = this.filteredSessions[this.selectedIndex];
		if (!selected) return;

		// Prevent deleting current session
		if (this.isCurrentSessionPath(selected.session.path)) {
			this.onError?.("Cannot delete the currently active session");
			return;
		}

		this.setConfirmingDeletePath(selected.session.path);
	}

	private isCurrentSessionPath(path: string): boolean {
		if (!this.currentSessionCanonicalPath) return false;
		return (canonicalizePath(path) ?? path) === this.currentSessionCanonicalPath;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		// Render search input
		lines.push(...this.searchInput.render(width));
		lines.push(""); // Blank line after search

		if (this.filteredSessions.length === 0) {
			let emptyMessage: string;
			if (this.nameFilter === "named") {
				const toggleKey = keyText("app.session.toggleNamedFilter");
				if (this.showCwd) {
					emptyMessage = `  No named sessions found. Press ${toggleKey} to show all.`;
				} else {
					emptyMessage = `  No named sessions in current folder. ${toggleKey} show all · tab view all.`;
				}
			} else if (this.showCwd) {
				// "All" scope - no sessions anywhere that match filter
				emptyMessage = "  No sessions found";
			} else {
				// "Current folder" scope - hint to try "all"
				emptyMessage = "  No sessions in current folder. tab view all.";
			}
			lines.push(theme.fg("muted", truncateToWidth(emptyMessage, width, "…")));
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredSessions.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredSessions.length);

		// Render visible sessions (one line each with tree structure)
		for (let i = startIndex; i < endIndex; i++) {
			const node = this.filteredSessions[i]!;
			const session = node.session;
			const isSelected = i === this.selectedIndex;
			const isConfirmingDelete = session.path === this.confirmingDeletePath;
			const isCurrent = this.isCurrentSessionPath(session.path);

			// Build tree prefix
			const prefix = this.buildTreePrefix(node);

			// Session display text (name or first message)
			const hasName = !!session.name;
			const displayText = session.name ?? session.firstMessage;
			const normalizedMessage = displayText.replace(/[\x00-\x1f\x7f]/g, " ").trim();

			// Right side: message count and age
			const age = formatSessionDate(session.modified);
			const msgCount = String(session.messageCount);
			let rightPart = `${msgCount} ${age}`;
			if (this.showCwd && session.cwd) {
				rightPart = `${shortenPath(session.cwd)} ${rightPart}`;
			}
			if (this.showPath) {
				rightPart = `${shortenPath(session.path)} ${rightPart}`;
			}

			// Cursor
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

			// Calculate available width for message
			const prefixWidth = visibleWidth(prefix);
			const rightWidth = visibleWidth(rightPart) + 2; // +2 for spacing
			const availableForMsg = width - 2 - prefixWidth - rightWidth; // -2 for cursor

			const truncatedMsg = truncateToWidth(normalizedMessage, Math.max(10, availableForMsg), "…");

			// Style message
			let messageColor: "error" | "warning" | "accent" | null = null;
			if (isConfirmingDelete) {
				messageColor = "error";
			} else if (isCurrent) {
				messageColor = "accent";
			} else if (hasName) {
				messageColor = "warning";
			}
			let styledMsg = messageColor ? theme.fg(messageColor, truncatedMsg) : truncatedMsg;
			if (isSelected) {
				styledMsg = theme.bold(styledMsg);
			}

			// Build line
			const leftPart = cursor + theme.fg("dim", prefix) + styledMsg;
			const leftWidth = visibleWidth(leftPart);
			const spacing = Math.max(1, width - leftWidth - visibleWidth(rightPart));
			const styledRight = theme.fg(isConfirmingDelete ? "error" : "dim", rightPart);

			let line = leftPart + " ".repeat(spacing) + styledRight;
			if (isSelected) {
				line = theme.bg("selectedBg", line);
			}
			lines.push(truncateToWidth(line, width));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredSessions.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredSessions.length})`;
			const scrollInfo = theme.fg("muted", truncateToWidth(scrollText, width, ""));
			lines.push(scrollInfo);
		}

		return lines;
	}

	private buildTreePrefix(node: FlatSessionNode): string {
		if (node.depth === 0) {
			return "";
		}

		const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
		const branch = node.isLast ? "└─ " : "├─ ";
		return parts.join("") + branch;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		// Handle delete confirmation state first - intercept all keys
		if (this.confirmingDeletePath !== null) {
			if (kb.matches(keyData, "tui.select.confirm")) {
				const pathToDelete = this.confirmingDeletePath;
				this.setConfirmingDeletePath(null);
				void this.onDeleteSession?.(pathToDelete);
				return;
			}
			if (kb.matches(keyData, "tui.select.cancel")) {
				this.setConfirmingDeletePath(null);
				return;
			}
			// Ignore all other keys while confirming
			return;
		}

		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.onToggleScope) {
				this.onToggleScope();
			}
			return;
		}

		if (kb.matches(keyData, "app.session.toggleSort")) {
			this.onToggleSort?.();
			return;
		}

		if (this.keybindings.matches(keyData, "app.session.toggleNamedFilter")) {
			this.onToggleNameFilter?.();
			return;
		}

		// Ctrl+P: toggle path display
		if (kb.matches(keyData, "app.session.togglePath")) {
			this.showPath = !this.showPath;
			this.onTogglePath?.(this.showPath);
			return;
		}

		// Ctrl+D: initiate delete confirmation (useful on terminals that don't distinguish Ctrl+Backspace from Backspace)
		if (kb.matches(keyData, "app.session.delete")) {
			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		// Rename selected session
		if (kb.matches(keyData, "app.session.rename")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected) {
				this.onRenameSession?.(selected.session.path);
			}
			return;
		}

		// Ctrl+Backspace: non-invasive convenience alias for delete
		// Only triggers deletion when the query is empty; otherwise it is forwarded to the input
		if (kb.matches(keyData, "app.session.deleteNoninvasive")) {
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.handleInput(keyData);
				this.filterSessions(this.searchInput.getValue());
				return;
			}

			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		// Up arrow
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		}
		// Down arrow
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1);
		}
		// Page up - jump up by maxVisible items
		else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		}
		// Page down - jump down by maxVisible items
		else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible);
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.session.path);
			}
		}
		// Escape - cancel
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterSessions(this.searchInput.getValue());
		}
	}
}
