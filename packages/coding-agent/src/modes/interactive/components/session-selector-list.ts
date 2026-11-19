import { dirname } from "node:path";
import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	type KeyId,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@bastani/atomic-tui";
import { keybindingIdentity } from "../../../core/keybinding-identity.js";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { SessionInfo } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";
import {
	clickableKeyTextHint,
	type NavKey,
	type NavKeybindings,
	type NavKeyStyle,
	navActionText,
	navFirstKeyText,
	navKeyText,
	renderNavHintLine,
	renderNavKeyOverlay,
} from "./nav-keys.ts";
import {
	filterAndSortSessions,
	hasSessionName,
	matchSession,
	type NameFilter,
	parseSearchQuery,
	type SortMode,
} from "./session-selector-search.ts";
import { buildSessionTree, type FlatSessionNode, flattenSessionTree } from "./session-selector-tree.ts";
import {
	formatSessionDate,
	getSessionPathKey,
	isSessionPathKeyResolved,
	shortenPath,
	truncatePathStart,
} from "./session-selector-utils.ts";

export type SessionListVariant = "sessions" | "runs" | "mixed";

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

const CLEAN_TEXT_CACHE_SIZE = 4096;
const cleanTextCache = new Map<string, string>();

function cleanText(text: string): string {
	const cached = cleanTextCache.get(text);
	if (cached !== undefined) return cached;
	const cleaned = text
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (cleanTextCache.size >= CLEAN_TEXT_CACHE_SIZE) cleanTextCache.clear();
	cleanTextCache.set(text, cleaned);
	return cleaned;
}

const FITTED_TEXT_CACHE_SIZE = 4096;
const fittedTextCache = new Map<string, string>();

function fitText(text: string, room: number): string {
	const key = `${room}\u0000${text}`;
	const cached = fittedTextCache.get(key);
	if (cached !== undefined) return cached;
	const fitted = visibleWidth(text) <= room ? text : truncateToWidth(text, room, "…");
	if (fittedTextCache.size >= FITTED_TEXT_CACHE_SIZE) fittedTextCache.clear();
	fittedTextCache.set(key, fitted);
	return fitted;
}

function ageText(date: Date): string {
	const short = formatSessionDate(date);
	return short === "now" ? "just now" : `${short} ago`;
}

export function sessionRowTitle(session: SessionInfo): string {
	return cleanText(session.title ?? session.name ?? session.firstMessage) || "(no messages)";
}

const RESUME_HINT_DROP_ORDER = [
	"path",
	"hide path",
	"named",
	"all names",
	"sort",
	"delete",
	"rename",
	"scope",
	"all",
	"this folder",
	"to search",
	"select",
	"preview",
	"close preview",
	"resume",
	"keys",
	"keep",
];

function entryWidth(entry: NavKey, keybindings: NavKeybindings): number {
	const keys = entry.action !== undefined ? navActionText(keybindings, entry.action) : (entry.keys ?? "");
	return keys ? visibleWidth(`${keys} ${entry.label}`) : 0;
}

function fitResumeHint(entries: readonly NavKey[], room: number, keybindings: NavKeybindings): NavKey[] {
	const separator = visibleWidth(" · ");
	const widths = entries.map((entry) => entryWidth(entry, keybindings));
	const kept = entries.map((_, index) => index);
	let total = widths.reduce((sum, width) => sum + width, 0) + separator * Math.max(0, entries.length - 1);
	for (const label of RESUME_HINT_DROP_ORDER) {
		if (total <= room || kept.length <= 1) break;
		const at = kept.findIndex(
			(index) =>
				entries[index]!.label === label && (entries[index]!.action !== "tui.select.confirm" || label === "resume"),
		);
		if (at < 0) continue;
		total -= widths[kept[at]!]! + (kept.length > 1 ? separator : 0);
		kept.splice(at, 1);
	}
	return kept.map((index) => entries[index]!);
}

function isSearchEditingKey(key: KeyId): boolean {
	const id = keybindingIdentity(key);
	if (id.length === 1) return true;
	if (id.startsWith("shift+") && id.length === 7) return true;
	return (
		id === "space" ||
		id === "backspace" ||
		id === "delete" ||
		id === "left" ||
		id === "right" ||
		id === "home" ||
		id === "end"
	);
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
	private pendingSelectedId?: string;
	private searchInput: Input;
	private showCwd = false;
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private keybindings: KeybindingsManager;
	private showPath = false;
	private showingHelp = false;
	private confirmingDeleteSession: SessionInfo | null = null;
	private paintedSelection: SessionInfo | null | undefined;
	private selectionUnpainted = false;
	private listComplete = false;
	private selectionSettled = false;
	private deletingSessionPath?: string;
	private deletingRunId?: string;
	private currentSession?: { id: string; directory?: string };
	public onSelect?: (session: SessionInfo) => void;
	public onCancel?: () => void;
	public onExit: () => void = () => {};
	public onToggleScope?: () => void;
	public onToggleSort?: () => void;
	public onToggleNameFilter?: () => void;
	public onTogglePath?: (showPath: boolean) => void;
	public onDeleteConfirmationChange?: (path: string | null) => void;
	public onDeletePendingChange?: () => void;
	public onDeleteSession?: (sessionPath: string, session: SessionInfo) => Promise<void>;
	public onRenameSession?: (session: SessionInfo) => void;
	public onError?: (message: string) => void;
	private maxVisible: number = 6;
	private variant: SessionListVariant = "sessions";
	private canDelete = true;
	private canRename = false;
	private previewOpen = false;
	private detailCache = new WeakMap<SessionInfo, { key: string; line: string }>();
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

	private activeKeybindings(): NavKeybindings {
		if (Object.keys(this.keybindings.getUserBindings()).length > 0) return this.keybindings;
		return getKeybindings();
	}

	private isSameSession(left: SessionInfo, right: SessionInfo): boolean {
		return left === right || (this.variant === "runs" ? left.id === right.id : left.path === right.path);
	}

	private createSearchInput(): Input {
		const input = new Input({
			prompt: "⌕ ",
			placeholder: "Search…",
			placeholderStyle: (text) => theme.fg("dim", text),
		});
		input.focused = this._focused;
		input.onSubmit = () => this.selectSession();
		return input;
	}

	private clearSearch(): void {
		const selected = this.filteredSessions[this.selectedIndex]?.session;
		const selectedPath = selected?.path;
		const selectedId = selected?.id;
		this.searchInput = this.createSearchInput();
		this.filterSessions("");
		const index = this.findSessionIndex(selectedPath, selectedId);
		if (index >= 0) this.selectedIndex = index;
	}

	private findSessionIndex(path: string | undefined, id?: string): number {
		if (!path && !id) return -1;
		if (path) {
			const byPath = this.filteredSessions.findIndex((node) => node.session.path === path);
			if (byPath >= 0) return byPath;
		}
		if (this.variant !== "runs" || !id) return -1;
		return this.filteredSessions.findIndex((node) => node.session.id === id);
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
		this.filterSessions(this.searchInput.getValue());
	}

	setNameFilter(nameFilter: NameFilter): void {
		const selected = this.filteredSessions[this.selectedIndex]?.session;
		this.nameFilter = nameFilter;
		this.filterSessions(this.searchInput.getValue());
		const index = this.findSessionIndex(selected?.path, selected?.id);
		if (index >= 0) this.selectedIndex = index;
	}

	setSessions(sessions: SessionInfo[], showCwd: boolean, partial = false): void {
		if (showCwd !== this.showCwd) {
			this.selectionSettled = false;
			if (!this.selectionTouched) {
				this.pendingSelectedPath = undefined;
				this.pendingSelectedId = undefined;
			}
		}
		this.replaceSessions(sessions, showCwd, partial);
		this.listComplete = !partial;
		if (this.paintedSelection === undefined) return;
		const selected = this.filteredSessions[this.selectedIndex]?.session;
		const painted = this.paintedSelection;
		if (selected === undefined ? painted !== null : painted === null || !this.isSameSession(selected, painted))
			this.selectionUnpainted = true;
	}

	private replaceSessions(sessions: SessionInfo[], showCwd: boolean, partial: boolean): void {
		const currentSelected = this.filteredSessions[this.selectedIndex]?.session;
		const keepSelected = this.selectionTouched || this.selectionSettled;
		const selectedPath = keepSelected ? (this.pendingSelectedPath ?? currentSelected?.path) : undefined;
		const selectedId = keepSelected ? (this.pendingSelectedId ?? currentSelected?.id) : undefined;
		this.allSessions = sessions;
		this.showCwd = showCwd;
		this.filterSessions(this.searchInput.getValue());
		if (this.confirmingDeleteSession !== null) {
			const match = this.filteredSessions.find((node) =>
				this.isSameSession(node.session, this.confirmingDeleteSession!),
			);
			this.setConfirmingDeleteSession(match?.session ?? null);
		}
		if (!selectedPath && !selectedId) return;
		const selectedIndex = this.findSessionIndex(selectedPath, selectedId);
		if (selectedIndex >= 0) {
			this.selectedIndex = selectedIndex;
			this.pendingSelectedPath = undefined;
			this.pendingSelectedId = undefined;
		} else {
			this.pendingSelectedPath = partial ? selectedPath : undefined;
			this.pendingSelectedId = partial ? selectedId : undefined;
		}
	}

	private filterSessions(query: string): void {
		const trimmed = query.trim();
		if (this.variant === "mixed") {
			const parsed = trimmed ? parseSearchQuery(query) : null;
			const matchesQuery = (session: SessionInfo): boolean => {
				if (!parsed) return true;
				if (parsed.error) return false;
				return matchSession(session, parsed).matches;
			};
			const byNewest = (left: SessionInfo, right: SessionInfo): number => {
				const diff = right.modified.getTime() - left.modified.getTime();
				if (diff !== 0) return diff;
				const idDiff = left.id.localeCompare(right.id);
				return idDiff !== 0 ? idDiff : left.path.localeCompare(right.path);
			};
			const rawSessions = this.allSessions.filter((session) => this.nameFilter === "all" || hasSessionName(session));
			let sessionNodes: FlatSessionNode[];
			if (this.sortMode === "threaded" && !trimmed) {
				sessionNodes = flattenSessionTree(buildSessionTree(rawSessions));
			} else if (this.sortMode === "relevance" && trimmed) {
				sessionNodes = filterAndSortSessions(rawSessions, query, "relevance", "all").map((session) => ({
					session,
					depth: 0,
					isLast: true,
					ancestorContinues: [],
				}));
			} else {
				sessionNodes = rawSessions
					.filter(matchesQuery)
					.sort(byNewest)
					.map((session) => ({
						session,
						depth: 0,
						isLast: true,
						ancestorContinues: [],
					}));
			}

			this.filteredSessions = sessionNodes;
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredSessions.length - 1));
			if (this.filteredSessions.length === 0) this.previewOpen = false;
			return;
		}

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
		if (this.filteredSessions.length === 0) this.previewOpen = false;
	}

	private setConfirmingDeleteSession(session: SessionInfo | null): void {
		this.confirmingDeleteSession = session;
		this.onDeleteConfirmationChange?.(session?.path ?? null);
	}

	private hasPendingDelete(): boolean {
		return this.deletingSessionPath !== undefined || this.deletingRunId !== undefined;
	}

	private isDeleting(session: SessionInfo): boolean {
		if (this.variant === "runs") {
			return this.deletingRunId !== undefined && session.id === this.deletingRunId;
		}
		return this.deletingSessionPath !== undefined && session.path === this.deletingSessionPath;
	}

	private selectSession(): void {
		if (this.selectionUnpainted) return;
		const selected = this.filteredSessions[this.selectedIndex]?.session;
		if (selected && !this.isDeleting(selected)) this.onSelect?.(selected);
	}

	private async deleteSession(session: SessionInfo): Promise<void> {
		const onDelete = this.onDeleteSession;
		if (!onDelete || this.hasPendingDelete()) return;
		if (this.variant === "runs") {
			this.deletingRunId = session.id;
		} else {
			this.deletingSessionPath = session.path;
		}
		this.onDeletePendingChange?.();
		try {
			await onDelete(session.path, session);
		} catch (error) {
			this.onError?.(`Failed to delete: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.deletingSessionPath = undefined;
			this.deletingRunId = undefined;
			this.onDeletePendingChange?.();
		}
	}

	private startDeleteConfirmationForSelectedSession(): void {
		const selected = this.filteredSessions[this.selectedIndex];
		if (!selected || !this.canDelete || selected.session.canDelete === false || this.hasPendingDelete()) return;

		// Prevent deleting current session
		if (this.isCurrentSession(selected.session)) {
			this.onError?.("Cannot delete the currently active session");
			return;
		}

		this.setConfirmingDeleteSession(selected.session);
	}

	private isCurrentSession(session: SessionInfo): boolean {
		if (this.variant === "runs") return false;
		if (this.currentSession === undefined || session.id !== this.currentSession.id) return false;
		const directory = this.currentSession.directory;
		if (directory === undefined) return true;
		const sessionDirectory = dirname(session.path);
		if (!isSessionPathKeyResolved(sessionDirectory) || !isSessionPathKeyResolved(directory)) return true;
		return getSessionPathKey(sessionDirectory) === getSessionPathKey(directory);
	}

	invalidate(): void {}

	setVariant(variant: SessionListVariant): void {
		const changed = this.variant !== variant;
		this.variant = variant;
		if (variant === "mixed" && changed && this.sortMode === "threaded") {
			this.sortMode = "recent";
		}
		if (changed) {
			this.filterSessions(this.searchInput.getValue());
		}
	}

	setCanDelete(canDelete: boolean): void {
		this.canDelete = canDelete;
	}

	setCanRename(canRename: boolean): void {
		this.canRename = canRename;
	}

	setNoticeProvider(provider: () => SessionListNotice | undefined): void {
		this.noticeProvider = provider;
	}

	isPreviewOpen(): boolean {
		return this.previewOpen;
	}

	render(width: number): string[] {
		if (this.showingHelp) {
			const kb = this.activeKeybindings();
			const helpKeys = this.availableHelpKeys();
			const overlayKb: NavKeybindings =
				helpKeys.length > 0
					? {
							matches: (data, action) => kb.matches(data, action),
							getKeys: (action) => (action === "app.keys.help" ? helpKeys : (kb.getKeys?.(action) ?? [])),
						}
					: kb;
			return renderNavKeyOverlay(
				"keys · resume",
				this.helpEntries(),
				width,
				HINT_STYLE,
				overlayKb,
				"tui.select.cancel",
			).map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
		}
		this.paintedSelection = this.filteredSessions[this.selectedIndex]?.session ?? null;
		this.selectionUnpainted = false;
		if (this.listComplete) this.selectionSettled = true;
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
		return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
	}

	private emptyText(): string {
		if (this.searchInput.getValue().trim()) return `No matches for "${this.searchInput.getValue().trim()}"`;
		if (this.variant === "runs") return "No runs to resume.";
		const showAll = clickableKeyTextHint(keyText("app.session.toggleNamedFilter"), " show all");
		const allFolders = clickableKeyTextHint(keyText("tui.input.tab"), " all folders");
		if (this.nameFilter === "named") {
			return this.showCwd
				? `No named sessions. ${showAll}.`
				: `No named sessions in this folder. ${showAll} · ${allFolders}.`;
		}
		return this.showCwd ? "No sessions found." : `No sessions in this folder. ${allFolders}.`;
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
		const headerRoom = Math.max(1, width - 2);
		if (this.variant === "mixed") {
			lines.push(
				`  ${theme.bold(theme.fg("muted", fitText(`Sessions (${this.filteredSessions.length})`, headerRoom)))}`,
			);
		}
		for (let i = start; i < end; i++) {
			const node = this.filteredSessions[i]!;
			const session = node.session;
			const isSelected = i === this.selectedIndex;
			const isConfirmingDelete =
				this.confirmingDeleteSession !== null && this.isSameSession(session, this.confirmingDeleteSession);
			const isDeleting = this.isDeleting(session);
			const prefix = this.buildTreePrefix(node);
			const continuation = this.buildTreeContinuation(node);
			const cursor = isSelected ? theme.fg("accent", theme.bold("❯ ")) : "  ";
			const lead = ` ${cursor}`;
			const indent = visibleWidth(lead);
			const titleRoom = Math.max(1, width - indent - visibleWidth(prefix) - 1);
			const title = fitText(sessionRowTitle(session), titleRoom);
			let color: "error" | "warning" | "accent" | "success" | null = null;
			if (isConfirmingDelete) color = "error";
			else if (isDeleting) color = "warning";
			else if (this.isCurrentSession(session)) color = "accent";
			else if (session.messageColor !== undefined) color = session.messageColor;
			else if (session.name) color = "warning";
			let styledTitle = color ? theme.fg(color, title) : theme.fg("text", title);
			if (isSelected) styledTitle = theme.bold(color ? styledTitle : theme.fg("accent", title));
			lines.push(lead + theme.fg("dim", prefix) + styledTitle);
			const detailRoom = Math.max(1, width - indent - visibleWidth(continuation) - 1);
			const detail = isDeleting ? "Deleting…" : this.rowDetail(session, detailRoom);
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

	private rowDetail(session: SessionInfo, room: number): string {
		if (session.detail !== undefined) return fitText(cleanText(session.detail), room);
		const sep = " · ";
		const head = `${ageText(session.modified)}${sep}${session.messageCount} ${session.messageCount === 1 ? "message" : "messages"}`;
		const key = `${room}\u0000${head}\u0000${this.showCwd}\u0000${this.showPath}\u0000${session.summary ?? ""}`;
		const cached = this.detailCache.get(session);
		if (cached?.key === key) return cached.line;
		const line = this.fitDetail(session, room, head, sep);
		this.detailCache.set(session, { key, line });
		return line;
	}

	private fitDetail(session: SessionInfo, room: number, head: string, sep: string): string {
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
			const wrapped = wrapTextWithAnsi(cleanText(text), room);
			const shown = wrapped.slice(0, maxLines);
			if (wrapped.length > shown.length) {
				const last = shown.length - 1;
				shown[last] = `${truncateToWidth(shown[last]!, Math.max(0, room - 1), "")}…`;
			}
			for (const line of shown) {
				const cell = truncateToWidth(line, room, "…");
				body.push(
					`  ${border("│")} ${style(cell)}${" ".repeat(Math.max(0, room - visibleWidth(cell)))} ${border("│")}`,
				);
			}
		};
		add(sessionRowTitle(selected), (text) => theme.bold(theme.fg("text", text)), 3);
		if (selected.detail !== undefined) add(selected.detail, (text) => theme.fg("muted", text), 4);
		else if (selected.summary) add(selected.summary, (text) => theme.fg("text", text), 6);
		const isRun = this.variant === "runs";
		const facts: string[] = [];
		facts.push(`Created ${selected.created.toLocaleString()} · updated ${ageText(selected.modified)}`);
		if (selected.detail === undefined && !isRun)
			facts.push(`${selected.messageCount} ${selected.messageCount === 1 ? "message" : "messages"}`);
		const pathFact = (path: string): string => {
			const text = cleanText(shortenPath(path));
			return wrapTextWithAnsi(text, room).length > 2 ? truncatePathStart(text, room) : text;
		};
		if (selected.cwd && !isRun) facts.push(pathFact(selected.cwd));
		if (!isRun) facts.push(pathFact(selected.path));
		else facts.push(selected.id);
		for (const fact of facts) add(fact, (text) => theme.fg("dim", text), 2);
		return ["", rule, ...body, end];
	}

	private availableHelpKeys(): readonly KeyId[] {
		if (this.variant !== "mixed") return [];
		const kb = this.activeKeybindings();
		const query = this.searchInput.getValue();
		const selected = this.filteredSessions[this.selectedIndex]?.session;
		const isSession = selected !== undefined;
		const claimed = new Set([keybindingIdentity("ctrl+c")]);
		const actionKeys = (action: string): readonly KeyId[] => (kb.getKeys?.(action) ?? []) as readonly KeyId[];
		const claim = (action: string, enabled: boolean): void => {
			if (enabled) for (const key of actionKeys(action)) claimed.add(keybindingIdentity(key));
		};
		claim("tui.select.cancel", true);
		for (const action of ["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"]) {
			claim(action, this.filteredSessions.length > 1);
		}
		const canResume = selected !== undefined && !this.isDeleting(selected);
		claim("tui.select.confirm", canResume);
		claim("app.list.open", canResume && !query);
		if (selected && !query) claimed.add(keybindingIdentity("space"));
		claim("tui.input.tab", true);
		claim("app.session.rename", isSession && this.canRename && !this.isDeleting(selected!));
		const canDelete =
			selected !== undefined &&
			this.canDelete &&
			selected.canDelete !== false &&
			!this.hasPendingDelete() &&
			!this.isCurrentSession(selected);
		claim("app.session.delete", canDelete);
		claim("app.session.deleteNoninvasive", canDelete);
		claim("app.session.toggleSort", this.filteredSessions.length > 1 || Boolean(query));
		claim("app.session.toggleNamedFilter", true);
		claim("app.session.togglePath", isSession);
		const configured = actionKeys("app.keys.help").filter(
			(key) => !claimed.has(keybindingIdentity(key)) && (!query || !isSearchEditingKey(key)),
		);
		if (configured.length > 0) return configured;
		if (query && !claimed.has(keybindingIdentity("f1"))) return ["f1" as KeyId];
		return [];
	}

	private mixedHintParts(): { core: NavKey[]; extras: NavKey[]; help?: NavKey } {
		const kb = this.activeKeybindings();
		const selected = this.filteredSessions[this.selectedIndex];
		const selectedDeleting = selected !== undefined && this.isDeleting(selected.session);
		const selectedIsSession = selected !== undefined;
		const query = this.searchInput.getValue();
		const cancel = navFirstKeyText(kb, "tui.select.cancel") || "esc";
		const core: NavKey[] = [];
		if (selected && !query) core.push({ keys: "space", label: this.previewOpen ? "close preview" : "preview" });
		if (selected && !selectedDeleting) core.push({ action: "tui.select.confirm", label: "resume" });
		core.push({ keys: "type", label: "to search" });
		core.push({ keys: cancel, label: this.previewOpen ? "close" : query ? "clear" : "cancel" });

		const extras: NavKey[] = [];
		extras.push({ action: "tui.input.tab", label: "scope" });
		if (selectedIsSession && this.canRename && !selectedDeleting) {
			extras.push({ action: "app.session.rename", label: "rename" });
		}
		if (
			selected &&
			this.canDelete &&
			selected.session.canDelete !== false &&
			!this.hasPendingDelete() &&
			!this.isCurrentSession(selected.session)
		) {
			extras.push({ action: "app.session.delete", label: "delete" });
		}
		if (this.filteredSessions.length > 1 || query) {
			extras.push({ action: "app.session.toggleSort", label: "sort" });
		}
		extras.push({
			action: "app.session.toggleNamedFilter",
			label: this.nameFilter === "named" ? "all names" : "named",
		});
		if (selectedIsSession) {
			extras.push({ action: "app.session.togglePath", label: this.showPath ? "hide path" : "path" });
		}
		const helpKeys = this.availableHelpKeys();
		const help = helpKeys.length > 0 ? { keys: helpKeys.map(navKeyText).join("/"), label: "keys" } : undefined;
		return { core, extras, help };
	}

	private helpEntries(): NavKey[] {
		const kb = this.activeKeybindings();
		const entries: NavKey[] = [];
		if (this.filteredSessions.length > 1) {
			const up = navActionText(kb, "tui.select.up");
			const down = navActionText(kb, "tui.select.down");
			entries.push({
				keys: up === "↑" && down === "↓" ? "↑↓" : [up, down].filter(Boolean).join("/"),
				label: "select",
			});
		}
		if (this.variant === "mixed") {
			const { core, extras } = this.mixedHintParts();
			return [...entries, ...core, ...extras];
		}
		return this.hintEntries().filter((entry) => entry.action !== "app.keys.help");
	}

	private hintEntries(): NavKey[] {
		const kb = this.activeKeybindings();
		const entries: NavKey[] = [];
		const selected = this.filteredSessions[this.selectedIndex];
		if (this.confirmingDeleteSession !== null) {
			entries.push({ action: "tui.select.confirm", label: "delete" });
			entries.push({ keys: navFirstKeyText(kb, "tui.select.cancel") || "esc", label: "keep" });
			return entries;
		}
		if (this.variant === "mixed") {
			const { core, extras, help } = this.mixedHintParts();
			return [...core, ...extras, ...(help ? [help] : [])];
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
		const selectedDeleting = selected !== undefined && this.isDeleting(selected.session);
		if (selected && !selectedDeleting) entries.push({ action: "tui.select.confirm", label: "resume" });
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
		if (selected && this.canRename && this.variant !== "runs" && !selectedDeleting)
			entries.push({ action: "app.session.rename", label: "rename" });
		if (
			selected &&
			this.canDelete &&
			selected.session.canDelete !== false &&
			!this.hasPendingDelete() &&
			!this.isCurrentSession(selected.session)
		)
			entries.push({ action: "app.session.delete", label: "delete" });
		entries.push({ keys: "type", label: "to search" });
		const cancel = navFirstKeyText(kb, "tui.select.cancel") || "esc";
		entries.push({ keys: cancel, label: this.previewOpen ? "close" : query ? "clear" : "cancel" });
		return entries;
	}

	private renderHint(width: number): string {
		const kb = this.activeKeybindings();
		const room = Math.max(1, width - 2);
		return renderNavHintLine(fitResumeHint(this.hintEntries(), room, kb), width, HINT_STYLE, kb);
	}

	private buildTreePrefix(node: FlatSessionNode): string {
		if (node.depth === 0) {
			return "";
		}

		const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
		const branch = node.isLast ? "└─ " : "├─ ";
		return parts.join("") + branch;
	}

	private buildTreeContinuation(node: FlatSessionNode): string {
		if (node.depth === 0) return "";
		const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
		return parts.join("") + (node.isLast ? "   " : "│  ");
	}

	handleInput(keyData: string): boolean {
		const kb = this.activeKeybindings();

		if (this.showingHelp) {
			if (matchesKey(keyData, "ctrl+c")) {
				this.showingHelp = false;
				this.onCancel?.();
				return true;
			}
			if (
				kb.matches(keyData, "tui.select.cancel") ||
				kb.matches(keyData, "app.keys.help") ||
				this.availableHelpKeys().some((key) => matchesKey(keyData, keybindingIdentity(key) as KeyId))
			) {
				this.showingHelp = false;
			}
			return true;
		}

		// Handle delete confirmation state first - intercept all keys
		if (this.confirmingDeleteSession !== null) {
			if (matchesKey(keyData, "ctrl+c")) {
				this.setConfirmingDeleteSession(null);
				this.onCancel?.();
				return true;
			}
			if (kb.matches(keyData, "tui.select.confirm")) {
				const session = this.confirmingDeleteSession;
				this.setConfirmingDeleteSession(null);
				void this.deleteSession(session);
				return true;
			}
			if (kb.matches(keyData, "tui.select.cancel")) {
				this.setConfirmingDeleteSession(null);
				return true;
			}
			// Ignore all other keys while confirming
			return true;
		}

		if (this.availableHelpKeys().some((key) => matchesKey(keyData, keybindingIdentity(key) as KeyId))) {
			this.showingHelp = true;
			return true;
		}

		if (this.previewOpen && kb.matches(keyData, "tui.select.cancel") && !matchesKey(keyData, "ctrl+c")) {
			this.previewOpen = false;
			return true;
		}

		if (keyData === " " && !this.searchInput.getValue()) {
			if (this.filteredSessions[this.selectedIndex]) this.previewOpen = !this.previewOpen;
			return true;
		}

		const selected = this.filteredSessions[this.selectedIndex];
		const canUseSessionControls = this.variant !== "runs";

		if (kb.matches(keyData, "tui.input.tab")) {
			if (canUseSessionControls) this.onToggleScope?.();
			return true;
		}

		if (kb.matches(keyData, "app.session.toggleSort")) {
			if (this.filteredSessions.length > 1 || this.searchInput.getValue()) {
				this.onToggleSort?.();
			}
			return true;
		}

		if (kb.matches(keyData, "app.session.toggleNamedFilter")) {
			if (canUseSessionControls) this.onToggleNameFilter?.();
			return true;
		}

		// Ctrl+P: toggle path display
		if (kb.matches(keyData, "app.session.togglePath")) {
			const canTogglePath = this.variant === "sessions" || (this.variant === "mixed" && selected !== undefined);
			if (!canTogglePath) return true;
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
			if (selected && this.canRename && this.variant !== "runs" && !this.isDeleting(selected.session)) {
				this.selectionTouched = true;
				this.pendingSelectedPath = selected.session.path;
				this.pendingSelectedId = selected.session.id;
				this.onRenameSession?.(selected.session);
			}
			return true;
		}

		// Ctrl+Backspace: non-invasive convenience alias for delete
		// Only triggers deletion when the query is empty; otherwise it is forwarded to the input
		if (kb.matches(keyData, "app.session.deleteNoninvasive")) {
			if (this.searchInput.getValue().length > 0) {
				this.editSearch(keyData);
				return true;
			}

			this.startDeleteConfirmationForSelectedSession();
			return true;
		}

		this.selectionTouched = true;
		this.pendingSelectedPath = undefined;
		this.pendingSelectedId = undefined;
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
		// Enter
		else if (
			kb.matches(keyData, "tui.select.confirm") ||
			(kb.matches(keyData, "app.list.open") && !this.searchInput.getValue())
		) {
			this.selectSession();
		} else if (kb.matches(keyData, "tui.select.cancel") || matchesKey(keyData, "ctrl+c")) {
			if (this.searchInput.getValue() && !matchesKey(keyData, "ctrl+c")) this.clearSearch();
			else this.onCancel?.();
		}
		// Pass everything else to search input
		else {
			this.editSearch(keyData);
		}
		return true;
	}

	private editSearch(keyData: string): void {
		const before = this.searchInput.getValue().trim();
		const previous = this.filteredSessions[this.selectedIndex]?.session;
		const previousPath = previous?.path;
		const previousId = previous?.id;
		this.searchInput.handleInput(keyData);
		const query = this.searchInput.getValue();
		this.filterSessions(query);
		if (query.trim() === before) return;
		if (query.trim()) {
			this.selectedIndex = 0;
			return;
		}
		const kept = this.findSessionIndex(previousPath, previousId);
		this.selectedIndex = kept >= 0 ? kept : 0;
	}
}
