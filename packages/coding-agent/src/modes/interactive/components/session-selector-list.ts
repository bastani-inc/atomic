import { dirname } from "node:path";
import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@bastani/atomic-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { SessionInfo } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";
import { type NavKey, type NavKeybindings, type NavKeyStyle, navActionText, renderNavHintLine } from "./nav-keys.ts";
import { filterAndSortSessions, hasSessionName, type NameFilter, type SortMode } from "./session-selector-search.ts";
import { buildSessionTree, type FlatSessionNode, flattenSessionTree } from "./session-selector-tree.ts";
import { formatSessionDate, getSessionPathKey, shortenPath, truncatePathStart } from "./session-selector-utils.ts";

/** What a resume picker lists: saved sessions (with folder scope and names) or workflow runs. */
export type SessionListVariant = "sessions" | "runs";

/** The line under the list: a pending delete question or a transient status. */
export interface SessionListNotice {
	readonly text: string;
	readonly tone: "error" | "accent" | "muted";
}

const HINT_STYLE: NavKeyStyle = {
	dim: (text) => theme.fg("dim", text),
	text: (text) => theme.fg("text", text),
	muted: (text) => theme.fg("muted", text),
	border: (text) => theme.fg("borderMuted", text),
	bold: (text) => theme.bold(text),
};

/** Control characters out and whitespace collapsed, so one row stays one line. */
function cleanText(text: string): string {
	return text
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** `2h ago`, `just now`. */
function ageText(date: Date): string {
	const short = formatSessionDate(date);
	return short === "now" ? "just now" : `${short} ago`;
}

/** A row's first line: a synthetic row's own title, else the session's name or first message. */
export function sessionRowTitle(session: SessionInfo): string {
	return cleanText(session.title ?? session.name ?? session.firstMessage) || "(no messages)";
}

/**
 * Labels in the order a narrow hint gives them up: the reminders and view toggles first, then the row actions, so
 * how to move, preview, resume and leave stay longest.
 */
const RESUME_HINT_DROP_ORDER = [
	"to search",
	"path",
	"hide path",
	"named",
	"all names",
	"sort",
	"all",
	"this folder",
	"rename",
	"delete",
	"select",
	"preview",
	"close preview",
];

function fitResumeHint(entries: readonly NavKey[], room: number, keybindings: NavKeybindings): NavKey[] {
	const separator = visibleWidth(" · ");
	const widths = entries.map((entry) =>
		visibleWidth(
			`${entry.action !== undefined ? navActionText(keybindings, entry.action) : (entry.keys ?? "")} ${entry.label}`,
		),
	);
	const kept = entries.map((_, index) => index);
	let total = widths.reduce((sum, width) => sum + width, 0) + separator * Math.max(0, entries.length - 1);
	for (const label of RESUME_HINT_DROP_ORDER) {
		if (total <= room) break;
		const at = kept.findIndex((index) => entries[index]!.label === label);
		if (at < 0) continue;
		total -= widths[kept[at]!]! + (kept.length > 1 ? separator : 0);
		kept.splice(at, 1);
	}
	return kept.map((index) => entries[index]!);
}

/**
 * Custom session list component with multi-line items and search
 */
export class SessionList implements Component, Focusable {
	public getSelectedSessionId(): string | undefined {
		const selected = this.filteredSessions[this.selectedIndex];
		return selected?.session.id;
	}
	public getSelectedSessionPath(): string | undefined {
		const selected = this.filteredSessions[this.selectedIndex];
		return selected?.session.path;
	}
	private allSessions: SessionInfo[] = [];
	private filteredSessions: FlatSessionNode[] = [];
	private selectedIndex: number = 0;
	private selectionTouched = false;
	private pendingSelectedPath?: string;
	private searchInput: Input;
	private showCwd = false;
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private keybindings: KeybindingsManager;
	private showPath = false;
	private confirmingDeleteSession: SessionInfo | null = null;
	private currentSession?: { id: string; directory?: string };
	public onSelect?: (session: SessionInfo) => void;
	public onCancel?: () => void;
	public onExit: () => void = () => {};
	public onToggleScope?: () => void;
	public onToggleSort?: () => void;
	public onToggleNameFilter?: () => void;
	public onTogglePath?: (showPath: boolean) => void;
	public onDeleteConfirmationChange?: (path: string | null) => void;
	public onDeleteSession?: (sessionPath: string, session: SessionInfo) => Promise<void>;
	public onRenameSession?: (session: SessionInfo) => void;
	public onError?: (message: string) => void;
	private maxVisible: number = 6; // Max sessions visible (two lines each)
	private variant: SessionListVariant = "sessions";
	private canDelete = true;
	private canRename = false;
	private previewOpen = false;
	private noticeProvider?: () => SessionListNotice | undefined;

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
		currentSession?: { id: string; directory?: string },
	) {
		this.allSessions = sessions;
		this.filteredSessions = [];
		this.searchInput = this.createSearchInput();
		this.showCwd = showCwd;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.keybindings = keybindings;
		this.currentSession = currentSession;
		this.filterSessions("");
	}

	private createSearchInput(): Input {
		const input = new Input({
			prompt: "⌕ ",
			placeholder: "Search…",
			placeholderStyle: (text) => theme.fg("dim", text),
		});
		input.focused = this._focused;
		input.onSubmit = () => {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected) this.onSelect?.(selected.session);
		};
		return input;
	}

	/** Empty the search with a fresh box, so its undo history cannot bring the old text back. */
	private clearSearch(): void {
		const selectedPath = this.getSelectedSessionPath();
		this.searchInput = this.createSearchInput();
		this.filterSessions("");
		const index = this.filteredSessions.findIndex((node) => node.session.path === selectedPath);
		if (index >= 0) this.selectedIndex = index;
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
		this.filterSessions(this.searchInput.getValue());
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
		this.filterSessions(this.searchInput.getValue());
	}

	setSessions(sessions: SessionInfo[], showCwd: boolean, partial = false): void {
		const selectedPath = this.selectionTouched
			? (this.pendingSelectedPath ?? this.getSelectedSessionPath())
			: undefined;
		this.allSessions = sessions;
		this.showCwd = showCwd;
		this.filterSessions(this.searchInput.getValue());
		if (!selectedPath) return;
		const selectedIndex = this.filteredSessions.findIndex((node) => node.session.path === selectedPath);
		if (selectedIndex >= 0) {
			this.selectedIndex = selectedIndex;
			this.pendingSelectedPath = undefined;
		} else {
			this.pendingSelectedPath = partial ? selectedPath : undefined;
		}
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
		// A preview shows the selected row; with no rows left there is nothing to preview.
		if (this.filteredSessions.length === 0) this.previewOpen = false;
	}

	private setConfirmingDeleteSession(session: SessionInfo | null): void {
		this.confirmingDeleteSession = session;
		this.onDeleteConfirmationChange?.(session?.path ?? null);
	}

	private startDeleteConfirmationForSelectedSession(): void {
		const selected = this.filteredSessions[this.selectedIndex];
		if (!selected || !this.canDelete) return;

		// Prevent deleting current session
		if (this.isCurrentSession(selected.session)) {
			this.onError?.("Cannot delete the currently active session");
			return;
		}

		this.setConfirmingDeleteSession(selected.session);
	}

	private isCurrentSession(session: SessionInfo): boolean {
		return (
			this.currentSession !== undefined &&
			session.id === this.currentSession.id &&
			(this.currentSession.directory === undefined ||
				getSessionPathKey(dirname(session.path)) === getSessionPathKey(this.currentSession.directory))
		);
	}

	invalidate(): void {}

	/** What the picker lists, which decides its title, empty text and keys. */
	setVariant(variant: SessionListVariant): void {
		this.variant = variant;
	}

	/** Whether the picker can delete a row (Ctrl+D); its hint and key follow this. */
	setCanDelete(canDelete: boolean): void {
		this.canDelete = canDelete;
	}

	/** Whether the picker can rename a row; its hint follows this. */
	setCanRename(canRename: boolean): void {
		this.canRename = canRename;
	}

	/** Read the state line under the list: a pending delete question or a transient status. */
	setNoticeProvider(provider: () => SessionListNotice | undefined): void {
		this.noticeProvider = provider;
	}

	isPreviewOpen(): boolean {
		return this.previewOpen;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(...this.renderSearch(width));
		lines.push("");

		if (this.filteredSessions.length === 0) {
			lines.push(`  ${theme.fg("muted", truncateToWidth(this.emptyText(), Math.max(1, width - 2), "…"))}`);
		} else {
			lines.push(...this.renderRows(width));
			if (this.previewOpen) lines.push(...this.renderPreview(width));
		}

		const notice = this.noticeProvider?.();
		if (notice) {
			lines.push("");
			lines.push(`  ${theme.fg(notice.tone, truncateToWidth(notice.text, Math.max(1, width - 2), "…"))}`);
		}
		lines.push("");
		lines.push(this.renderHint(width));
		return lines.map((line) => truncateToWidth(line, width));
	}

	private emptyText(): string {
		if (this.searchInput.getValue().trim()) return `No matches for "${this.searchInput.getValue().trim()}"`;
		if (this.variant === "runs") return "No workflow runs to resume.";
		const toggleKey = keyText("app.session.toggleNamedFilter");
		const tabKey = keyText("tui.input.tab");
		if (this.nameFilter === "named") {
			return this.showCwd
				? `No named sessions. ${toggleKey} show all.`
				: `No named sessions in this folder. ${toggleKey} show all · ${tabKey} all folders.`;
		}
		return this.showCwd ? "No sessions found." : `No sessions in this folder. ${tabKey} all folders.`;
	}

	private renderSearch(width: number): string[] {
		const boxWidth = Math.max(8, width - 2);
		const field = Math.max(1, boxWidth - 4);
		const content = this.searchInput.render(field)[0] ?? "";
		const pad = " ".repeat(Math.max(0, field - visibleWidth(content)));
		const color = this.searchInput.getValue() ? "muted" : "borderMuted";
		const border = (text: string) => theme.fg(color, text);
		return [
			` ${border(`╭${"─".repeat(boxWidth - 2)}╮`)}`,
			` ${border("│ ")}${content}${pad}${border(" │")}`,
			` ${border(`╰${"─".repeat(boxWidth - 2)}╯`)}`,
		];
	}

	private visibleRange(): { start: number; end: number } {
		const total = this.filteredSessions.length;
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), total - this.maxVisible),
		);
		return { start, end: Math.min(start + this.maxVisible, total) };
	}

	private renderRows(width: number): string[] {
		const lines: string[] = [];
		const { start, end } = this.visibleRange();
		if (start > 0) lines.push(`  ${theme.fg("dim", `↑ ${start} more`)}`);
		for (let i = start; i < end; i++) {
			const node = this.filteredSessions[i]!;
			const session = node.session;
			const isSelected = i === this.selectedIndex;
			const isConfirmingDelete = session === this.confirmingDeleteSession;
			const prefix = this.buildTreePrefix(node);
			const continuation = this.buildTreeContinuation(node);
			const cursor = isSelected ? theme.fg("accent", theme.bold("❯ ")) : "  ";
			const lead = ` ${cursor}`;
			const indent = visibleWidth(lead);
			const titleRoom = Math.max(1, width - indent - visibleWidth(prefix) - 1);
			const title = truncateToWidth(sessionRowTitle(session), titleRoom, "…");
			let color: "error" | "warning" | "accent" | "success" | null = null;
			if (isConfirmingDelete) color = "error";
			else if (this.isCurrentSession(session)) color = "accent";
			else if (session.messageColor !== undefined) color = session.messageColor;
			else if (session.name) color = "warning";
			let styledTitle = color ? theme.fg(color, title) : theme.fg("text", title);
			if (isSelected) styledTitle = theme.bold(color ? styledTitle : theme.fg("accent", title));
			lines.push(lead + theme.fg("dim", prefix) + styledTitle);
			const detailRoom = Math.max(1, width - indent - visibleWidth(continuation) - 1);
			const detail = this.rowDetail(session, detailRoom);
			lines.push(
				" ".repeat(indent) +
					theme.fg("dim", continuation) +
					theme.fg(isConfirmingDelete ? "error" : "muted", detail),
			);
		}
		if (end < this.filteredSessions.length) {
			lines.push(`  ${theme.fg("dim", `↓ ${this.filteredSessions.length - end} more`)}`);
		}
		return lines;
	}

	/**
	 * The row's dim second line, fitted to `room`: its own detail, or age · messages · folder · path · summary. A long
	 * folder or session path loses its start, never its end, and a summary takes only what the paths leave.
	 */
	private rowDetail(session: SessionInfo, room: number): string {
		if (session.detail !== undefined) return truncateToWidth(cleanText(session.detail), room, "…");
		const sep = " · ";
		const head = `${ageText(session.modified)}${sep}${session.messageCount} ${session.messageCount === 1 ? "message" : "messages"}`;
		const paths: string[] = [];
		if (this.showCwd && session.cwd) paths.push(shortenPath(session.cwd));
		if (this.showPath) paths.push(shortenPath(session.path));
		const summary = session.summary ? cleanText(session.summary) : "";
		let line = head;
		if (paths.length > 0) {
			const pathRoom = room - visibleWidth(line) - visibleWidth(sep) * paths.length;
			const share = Math.floor(pathRoom / paths.length);
			const fitted = paths.map((path) => truncatePathStart(path, Math.max(1, share))).filter(Boolean);
			if (pathRoom > paths.length * 2) line += fitted.map((path) => sep + path).join("");
		}
		if (summary && room - visibleWidth(line) - visibleWidth(sep) >= 10) {
			line += sep + truncateToWidth(summary, room - visibleWidth(line) - visibleWidth(sep), "…");
		}
		return truncateToWidth(line, room, "…");
	}

	/** The selected row in full: its title, summary and where it lives, wrapped under the list. */
	private renderPreview(width: number): string[] {
		const selected = this.filteredSessions[this.selectedIndex]?.session;
		if (!selected) return [];
		const inner = Math.max(10, width - 6);
		const room = inner - 2;
		const border = (text: string) => theme.fg("borderMuted", text);
		const rule = border(`  ╭${"─".repeat(inner)}╮`);
		const end = border(`  ╰${"─".repeat(inner)}╯`);
		const body: string[] = [];
		const add = (text: string, style: (value: string) => string, maxLines: number) => {
			const wrapped = wrapTextWithAnsi(cleanText(text), room).slice(0, maxLines);
			for (const line of wrapped) {
				const cell = truncateToWidth(line, room, "…");
				body.push(
					`  ${border("│")} ${style(cell)}${" ".repeat(Math.max(0, room - visibleWidth(cell)))} ${border("│")}`,
				);
			}
		};
		add(sessionRowTitle(selected), (text) => theme.bold(theme.fg("text", text)), 3);
		// A row with its own detail line already carries its summary there; a session shows its summary in full.
		if (selected.detail !== undefined) add(selected.detail, (text) => theme.fg("muted", text), 4);
		else if (selected.summary) add(selected.summary, (text) => theme.fg("text", text), 6);
		const facts: string[] = [];
		facts.push(`Created ${selected.created.toLocaleString()} · updated ${ageText(selected.modified)}`);
		if (selected.detail === undefined)
			facts.push(`${selected.messageCount} ${selected.messageCount === 1 ? "message" : "messages"}`);
		if (selected.cwd && this.variant !== "runs") facts.push(shortenPath(selected.cwd));
		if (this.variant !== "runs") facts.push(shortenPath(selected.path));
		else facts.push(selected.id);
		for (const fact of facts) add(fact, (text) => theme.fg("dim", text), 2);
		return ["", rule, ...body, end];
	}

	/** The keys that work now, in hint order; narrow terminals drop the least needed first. */
	private hintEntries(): NavKey[] {
		const kb = getKeybindings();
		const entries: NavKey[] = [];
		const selected = this.filteredSessions[this.selectedIndex];
		if (this.confirmingDeleteSession !== null) {
			entries.push({ action: "tui.select.confirm", label: "delete" });
			entries.push({ keys: navActionText(kb, "tui.select.cancel").split("/")[0] || "esc", label: "keep" });
			return entries;
		}
		const query = this.searchInput.getValue();
		if (this.filteredSessions.length > 1) {
			const up = navActionText(kb, "tui.select.up");
			const down = navActionText(kb, "tui.select.down");
			entries.push({
				keys: up === "↑" && down === "↓" ? "↑↓" : [up, down].filter(Boolean).join("/"),
				label: "select",
			});
		}
		if (selected && !query) entries.push({ keys: "space", label: this.previewOpen ? "close preview" : "preview" });
		if (selected) entries.push({ action: "tui.select.confirm", label: "resume" });
		if (this.variant === "sessions") {
			entries.push({ action: "tui.input.tab", label: this.showCwd ? "this folder" : "all" });
		}
		if (this.filteredSessions.length > 1 || query) entries.push({ action: "app.session.toggleSort", label: "sort" });
		if (this.variant === "sessions") {
			entries.push({
				action: "app.session.toggleNamedFilter",
				label: this.nameFilter === "named" ? "all names" : "named",
			});
			entries.push({ action: "app.session.togglePath", label: this.showPath ? "hide path" : "path" });
		}
		if (selected && this.canRename) entries.push({ action: "app.session.rename", label: "rename" });
		if (selected && this.canDelete) entries.push({ action: "app.session.delete", label: "delete" });
		entries.push({ keys: "type", label: "to search" });
		const cancel = navActionText(kb, "tui.select.cancel").split("/")[0] || "esc";
		entries.push({ keys: cancel, label: this.previewOpen ? "close" : query ? "clear" : "cancel" });
		return entries;
	}

	private renderHint(width: number): string {
		const kb = getKeybindings();
		return renderNavHintLine(fitResumeHint(this.hintEntries(), Math.max(1, width - 2), kb), width, HINT_STYLE, kb);
	}

	private buildTreePrefix(node: FlatSessionNode): string {
		if (node.depth === 0) {
			return "";
		}

		const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
		const branch = node.isLast ? "└─ " : "├─ ";
		return parts.join("") + branch;
	}

	/** The tree guide under a row's title, so a child's second line stays inside its branch. */
	private buildTreeContinuation(node: FlatSessionNode): string {
		if (node.depth === 0) return "";
		const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
		return parts.join("") + (node.isLast ? "   " : "│  ");
	}

	handleInput(keyData: string): boolean {
		const kb = getKeybindings();

		// Handle delete confirmation state first - intercept all keys
		if (this.confirmingDeleteSession !== null) {
			if (kb.matches(keyData, "tui.select.confirm")) {
				const session = this.confirmingDeleteSession;
				this.setConfirmingDeleteSession(null);
				void this.onDeleteSession?.(session.path, session);
				return true;
			}
			if (kb.matches(keyData, "tui.select.cancel")) {
				this.setConfirmingDeleteSession(null);
				return true;
			}
			// Ignore all other keys while confirming
			return true;
		}

		// A preview closes before anything else leaves; it follows the selection while open.
		if (this.previewOpen && kb.matches(keyData, "tui.select.cancel") && keyData !== "\x03") {
			this.previewOpen = false;
			return true;
		}

		if (keyData === " " && !this.searchInput.getValue()) {
			if (this.filteredSessions[this.selectedIndex]) this.previewOpen = !this.previewOpen;
			return true;
		}

		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.variant === "sessions") this.onToggleScope?.();
			return true;
		}

		if (kb.matches(keyData, "app.session.toggleSort")) {
			this.onToggleSort?.();
			return true;
		}

		if (this.keybindings.matches(keyData, "app.session.toggleNamedFilter")) {
			if (this.variant === "sessions") this.onToggleNameFilter?.();
			return true;
		}

		// Ctrl+P: toggle path display
		if (kb.matches(keyData, "app.session.togglePath")) {
			if (this.variant !== "sessions") return true;
			this.showPath = !this.showPath;
			this.onTogglePath?.(this.showPath);
			return true;
		}

		// Ctrl+D: initiate delete confirmation (useful on terminals that don't distinguish Ctrl+Backspace from Backspace)
		if (kb.matches(keyData, "app.session.delete")) {
			this.startDeleteConfirmationForSelectedSession();
			return true;
		}

		// Rename selected session
		if (kb.matches(keyData, "app.session.rename")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected) {
				this.selectionTouched = true;
				this.pendingSelectedPath = selected.session.path;
				this.onRenameSession?.(selected.session);
			}
			return true;
		}

		// Ctrl+Backspace: non-invasive convenience alias for delete
		// Only triggers deletion when the query is empty; otherwise it is forwarded to the input
		if (kb.matches(keyData, "app.session.deleteNoninvasive")) {
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.handleInput(keyData);
				this.filterSessions(this.searchInput.getValue());
				return true;
			}

			this.startDeleteConfirmationForSelectedSession();
			return true;
		}

		this.selectionTouched = true;
		this.pendingSelectedPath = undefined;
		// Up arrow
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		}
		// Down arrow
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = Math.max(0, Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1));
		}
		// Page up - jump up by maxVisible items
		else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		}
		// Page down - jump down by maxVisible items
		else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.max(
				0,
				Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible),
			);
		}
		// Enter, or → while it does not move the cursor through search text
		else if (
			kb.matches(keyData, "tui.select.confirm") ||
			(kb.matches(keyData, "app.list.open") && !this.searchInput.getValue())
		) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.session);
			}
		}
		// Escape clears a search first, then cancels; ctrl+c always cancels.
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.searchInput.getValue() && keyData !== "\x03") this.clearSearch();
			else this.onCancel?.();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterSessions(this.searchInput.getValue());
		}
		return true;
	}
}
