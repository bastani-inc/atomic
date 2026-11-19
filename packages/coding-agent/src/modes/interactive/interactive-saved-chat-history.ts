import { type Component, type ScrollView, Text } from "@bastani/atomic-tui";
import type { SessionEntry, SessionManager } from "../../core/session-manager.ts";
import type {
	SessionHistoryItem,
	SessionHistoryPage,
	SessionHistoryReadOptions,
} from "../../core/storage/session/types.js";
import { savedRowKey } from "../../core/tasks/transcript-origin.js";
import { parkedRun } from "./components/parked-rows.ts";
import { SavedRendererInstances } from "./components/saved-renderer-instances.js";

export type { SavedRendererInstances } from "./components/saved-renderer-instances.js";

import type { NewMessageCounter } from "./components/jump-to-latest.ts";
import { disposeRenderer } from "./components/renderer-disposal.js";
import { type InteractiveModeBase, isChatMessageComponent } from "./interactive-mode-base.ts";
import { StartupChatContainer } from "./interactive-startup-chat-container.ts";

type Direction = "older" | "newer" | "start" | "end";
type Draw = (
	mode: InteractiveModeBase,
	entries: SessionEntry[],
	seqs: number[],
	exceptions: SavedRendererInstances,
	adjacent: { readonly older?: string; readonly newer?: string } | undefined,
) => Component[];

const exceptionsByHost = new WeakMap<
	InteractiveModeBase,
	{ manager: SessionManager; id: string; exceptions: SavedRendererInstances }
>();
interface MountedPage {
	readonly children: Component[];
	readonly older?: string;
	readonly newer?: string;
	/** The saved sequences the page shows, and the range of the read it came from. A page without cursors at an edge
	 * of a narrower range continues past it with a range read, so pages stay contiguous around a parked anchor. */
	readonly first: number;
	readonly last: number;
	readonly from: number;
	readonly to: number;
}
interface PageRequest {
	readonly options: SessionHistoryReadOptions;
	readonly from: number;
	readonly to: number;
}
/**
 * What a live compaction leaves of a reader parked above the end: the rows they see of the window it retired, which
 * stay as one page between the saved history and the new context, with the saved sequences those rows show.
 */
export interface ParkedRows {
	readonly rows: readonly Component[];
	readonly first: number;
	readonly last: number;
}
const mounts = new WeakMap<InteractiveModeBase, SavedChatHistory>();

export function releaseSavedChatHistory(mode: InteractiveModeBase, closed = false): void {
	mounts.get(mode)?.dispose();
	mounts.delete(mode);
	if (closed) {
		exceptionsByHost.get(mode)?.exceptions.dispose();
		exceptionsByHost.delete(mode);
	}
}

/** A clear can retain some entries from before its boundary. Don't repeat them above the boundary. */
export function installSavedChatHistory(
	mode: InteractiveModeBase,
	context: SessionEntry[],
	draw: Draw,
	parked?: ParkedRows,
): void {
	const old = exceptionsByHost.get(mode);
	const changed =
		old !== undefined && (old.manager !== mode.sessionManager || old.id !== mode.sessionManager.getSessionId());
	releaseSavedChatHistory(mode, changed);
	const chat = mode.chatContainer;
	const view = mode.transcriptScrollView;
	const boundary = context[0];
	if (
		mode.ui.mode !== "fullscreen" ||
		!view ||
		!(chat instanceof StartupChatContainer) ||
		boundary?.type !== "compaction"
	)
		return;
	const manager = mode.sessionManager;
	const leaf = manager.getEntrySeq?.(boundary.id);
	if (!leaf) return;
	let first = leaf;
	for (const entry of context) first = Math.min(first, manager.getEntrySeq(entry.id) ?? first);
	if (first <= 1) return;
	const id = manager.getSessionId();
	let kept = exceptionsByHost.get(mode);
	if (!kept || kept.manager !== manager || kept.id !== id) {
		kept?.exceptions.dispose();
		kept = { manager, id, exceptions: new SavedRendererInstances() };
		exceptionsByHost.set(mode, kept);
	}
	const history = new SavedChatHistory(mode, manager, chat, view, draw, leaf, first - 1, kept.exceptions);
	if (parked && parked.last < first) history.park(parked);
	mounts.set(mode, history);
}

/** The context the chat last drew: its boundary and the last saved sequence in it. */
const shownContexts = new WeakMap<InteractiveModeBase, { id: string; boundary: string | undefined; through: number }>();
export function noteShownContext(mode: InteractiveModeBase, context: readonly SessionEntry[]): void {
	const manager: SessionManager | undefined = mode.sessionManager;
	const id = manager?.getSessionId?.();
	if (!manager || id === undefined) {
		shownContexts.delete(mode);
		return;
	}
	// The drawn context ends at its leaf, the latest saved entry it shows.
	const last = context.at(-1);
	const through = (last && manager.getEntrySeq?.(last.id)) ?? 0;
	const boundary = context[0]?.type === "compaction" ? context[0].id : undefined;
	shownContexts.set(mode, { id, boundary, through });
}

/** What the next drawing of a context does with the rows a parked reader sees. */
export interface ParkedViewport {
	/** Rows of the retired window, mounted as a page above the new context. */
	readonly parked: ParkedRows | undefined;
	/** Rows of entries the new context keeps, in order, which its drawing puts where the first of them belongs. */
	readonly adopted: readonly Component[];
	/** The adopted rows by saved row key, `${seq}:${part}`. */
	readonly keys: ReadonlyMap<string, Component>;
}

/**
 * A live compaction retires the window a reader parked above the end is reading. Take the rows they see out of the
 * chat before it is cleared: rows of the retired window, widened to every row of the messages they show, become a page
 * between the saved history and the new context; rows of entries the new context keeps are handed to its drawing.
 * Everything else of the old window is released as before. Undefined when the reader follows the end, when this is not
 * a new compaction of the drawn context, or when a row the reader sees cannot be placed among the saved entries.
 */
export function parkViewport(mode: InteractiveModeBase, context: readonly SessionEntry[]): ParkedViewport | undefined {
	const view = mode.transcriptScrollView;
	const chat = mode.chatContainer;
	const manager = mode.sessionManager;
	const boundary = context[0];
	const shown = shownContexts.get(mode);
	if (
		mode.ui.mode !== "fullscreen" ||
		!view ||
		view.isFollowingEnd ||
		!(chat instanceof StartupChatContainer) ||
		boundary?.type !== "compaction" ||
		!shown ||
		// An engine's host reopens its view of the same session: the conversation, not the object, must match.
		shown.id !== manager.getSessionId() ||
		shown.boundary === boundary.id
	)
		return undefined;
	const boundarySeq = manager.getEntrySeq?.(boundary.id);
	if (boundarySeq === undefined || boundarySeq <= shown.through) return undefined;
	let current = boundarySeq;
	for (const entry of context) current = Math.min(current, manager.getEntrySeq(entry.id) ?? current);
	const fixed = new Set<Component>([mode.resourceDisclosureContainer, mode.startupNoticesContainer]);
	const marker = mounts.get(mode)?.markerRow();
	if (marker) fixed.add(marker);
	const children = chat.children;
	const top = view.scrollTop;
	const bottom = top + view.viewportHeight;
	let first = -1;
	let last = -1;
	for (let index = 0; index < children.length; index++) {
		const span = chat.windowRowSpan(children[index]!);
		if (!span || span.bottom <= top || span.top >= bottom || fixed.has(children[index]!)) continue;
		if (first < 0) first = index;
		last = index;
	}
	if (first < 0) return undefined;
	const run = parkedRun(children, first, last, current, {
		fixed: (child) => fixed.has(child),
		message: isChatMessageComponent,
	});
	if (!run) return undefined;
	const retired = run.retired.filter((child) => !fixed.has(child));
	const kept = run.adopted.filter((child) => !fixed.has(child));
	const adopted = new Map<string, Component>();
	for (const child of kept) {
		const key = savedRowKey(child);
		if (key !== undefined && !adopted.has(key)) adopted.set(key, child);
	}
	const moving = new Set([...retired, ...kept]);
	mounts.get(mode)?.keep(moving);
	for (const child of moving) chat.removeChild(child);
	return {
		parked: retired.length ? { rows: retired, first: run.first, last: run.last } : undefined,
		adopted: kept,
		keys: adopted,
	};
}

function entryForDisplay(item: SessionHistoryItem): SessionEntry {
	return "entry" in item
		? item.entry
		: {
				type: "custom_message",
				id: `oversized-${item.seq}`,
				parentId: null,
				timestamp: "1970-01-01T00:00:00Z",
				display: true,
				customType: "atomic.oversized-history-entry",
				content: `Saved entry ${item.seq} is ${item.bytes} bytes. Read the original bytes with the session history reader or export this session.`,
			};
}

async function readVisiblePage(
	manager: SessionManager,
	options: SessionHistoryReadOptions,
): Promise<SessionHistoryPage | undefined> {
	const read = manager.readHistory(options);
	try {
		const page = await read.next();
		return page.done ? undefined : page.value;
	} finally {
		await read.return();
	}
}

/** Network I/O owns only its abort signal and a weak return address, not the terminal and every rendered row. */
function requestPage(
	owner: WeakRef<SavedChatHistory>,
	signal: AbortSignal,
	direction: Direction,
	range: { readonly from: number; readonly to: number },
	read: Promise<SessionHistoryPage | undefined>,
): void {
	void read.then(
		(page) => {
			if (!signal.aborted) owner.deref()?.publish(direction, page, range);
		},
		(error) => {
			if (!signal.aborted) owner.deref()?.failed(error);
		},
	);
}

class SavedChatHistory {
	private readonly marker = new Text("Earlier messages are saved above this point.", 1, 0);
	private readonly pages: MountedPage[] = [];
	private pending?: AbortController;
	private readonly counter?: NewMessageCounter;
	private readonly mode: InteractiveModeBase;
	private readonly manager: SessionManager;
	private readonly chat: StartupChatContainer;
	private readonly view: ScrollView;
	private readonly draw: Draw;
	private readonly leaf: number;
	private readonly through: number;
	private readonly exceptions: SavedRendererInstances;
	constructor(
		mode: InteractiveModeBase,
		manager: SessionManager,
		chat: StartupChatContainer,
		view: ScrollView,
		draw: Draw,
		leaf: number,
		through: number,
		exceptions: SavedRendererInstances,
	) {
		this.exceptions = exceptions;
		this.mode = mode;
		this.manager = manager;
		this.chat = chat;
		this.view = view;
		this.draw = draw;
		this.leaf = leaf;
		this.through = through;
		this.counter = (mode.ui as typeof mode.ui & { newMessages?: NewMessageCounter }).newMessages;
		chat.addChild(this.marker);
		view.setHistoryNavigation((action) => this.navigate(action));
	}

	private navigate(direction: Direction): void {
		if (direction === "end") {
			this.cancel();
			this.clearPages();
			this.mode.ui.requestRender();
			return;
		}
		if (this.mode.sessionManager !== this.manager || !this.chat.children.includes(this.marker)) {
			this.dispose();
			return;
		}
		if (direction === "start" || (direction === "newer" && this.view.isFollowingEnd)) this.cancel();
		else if (this.pending) return;
		const request = this.request(direction);
		if (!request) return;
		const top = this.view.scrollTop,
			height = this.view.viewportHeight;
		if (direction === "older" && top > (this.chat.windowRowSpan(this.marker)?.bottom ?? 1) + height) return;
		if (direction === "newer") {
			const last = this.pages.at(-1)?.children.at(-1);
			if (last && top + 2 * height < (this.chat.windowRowSpan(last)?.bottom ?? 0)) return;
		}
		const controller = new AbortController();
		this.pending = controller;
		requestPage(
			new WeakRef(this),
			controller.signal,
			direction,
			request,
			readVisiblePage(this.manager, { ...request.options, adjacent: true, signal: controller.signal }),
		);
	}

	/** The read that continues the mounted pages in `direction`: a page's cursor, else a range past its edge. */
	private request(direction: Direction): PageRequest | undefined {
		const leaf = this.leaf;
		const all = { from: 1, to: this.through };
		if (direction === "start")
			return { ...all, options: { branchLeafSeq: leaf, toSeq: this.through, direction: "forward" } };
		const edge = direction === "older" ? this.pages[0] : this.pages.at(-1);
		if (!edge) {
			return direction === "older"
				? { ...all, options: { branchLeafSeq: leaf, toSeq: this.through, direction: "backward" } }
				: undefined;
		}
		const range = { from: edge.from, to: edge.to };
		if (direction === "older") {
			if (edge.older) return { ...range, options: { cursor: edge.older } };
			return edge.from > 1 && edge.first > 1
				? {
						from: 1,
						to: edge.first - 1,
						options: { branchLeafSeq: leaf, toSeq: edge.first - 1, direction: "backward" },
					}
				: undefined;
		}
		if (edge.newer) return { ...range, options: { cursor: edge.newer } };
		return edge.to < this.through && edge.last < this.through
			? {
					from: edge.last + 1,
					to: this.through,
					options: { branchLeafSeq: leaf, fromSeq: edge.last + 1, toSeq: this.through, direction: "forward" },
				}
			: undefined;
	}

	/**
	 * Mount the rows a reader parked above the end saw of the window a compaction just retired, as the page they are
	 * on. They are already drawn, so the reader keeps their place, selection and stateful renderers; reads continue
	 * past either edge of the saved sequences they show.
	 */
	park(parked: ParkedRows): void {
		const children = [...parked.rows];
		this.chat.insertChildren(this.chat.children.indexOf(this.marker) + 1, children);
		this.pages.push({ children, first: parked.first, last: parked.last, from: parked.first, to: parked.last });
	}

	markerRow(): Component {
		return this.marker;
	}

	/** Forget pages whose rows move on, releasing only their rows that do not. */
	keep(rows: ReadonlySet<Component>): void {
		for (let index = this.pages.length - 1; index >= 0; index--) {
			const page = this.pages[index]!;
			if (!page.children.some((child) => rows.has(child))) continue;
			this.pages.splice(index, 1);
			this.drop({ ...page, children: page.children.filter((child) => !rows.has(child)) });
		}
	}

	publish(
		direction: Direction,
		page: SessionHistoryPage | undefined,
		range: { readonly from: number; readonly to: number },
	): void {
		this.pending = undefined;
		const at = this.chat.children.indexOf(this.marker);
		if (!page || at < 0 || this.mode.sessionManager !== this.manager) return;
		if (direction === "start") this.clearPages();
		const children = this.draw(
			this.mode,
			page.items.map(entryForDisplay),
			page.items.map((item) => item.seq),
			this.exceptions,
			page.adjacent,
		);
		const mounted: MountedPage = {
			children,
			older: page.adjacent?.older,
			newer: page.adjacent?.newer,
			first: page.items[0]?.seq ?? range.from,
			last: page.items.at(-1)?.seq ?? range.to,
			from: range.from,
			to: range.to,
		};
		if (direction === "newer") {
			const previous = this.pages.findLast((mountedPage) => mountedPage.children.length)?.children.at(-1);
			this.chat.insertChildren(previous ? this.chat.children.indexOf(previous) + 1 : at + 1, children);
			this.pages.push(mounted);
		} else {
			this.chat.insertChildren(at + 1, children);
			this.pages.unshift(mounted);
		}
		this.counter?.historyPrepended(children.filter(isChatMessageComponent).length);
		while (this.pages.length > 2) {
			const old = direction === "older" ? this.pages.at(-1)! : this.pages[0]!;
			if (this.painted(old)) break;
			this.drop(direction === "older" ? this.pages.pop()! : this.pages.shift()!);
		}
		if (direction === "start" || this.view.isFollowingEnd)
			this.view.scrollTo(direction === "start" ? 0 : this.view.scrollTop, { disableFollow: true });
		this.mode.ui.requestRender();
	}

	failed(error: unknown): void {
		this.pending = undefined;
		this.marker.setText(
			`Earlier messages: ${error instanceof Error ? error.message : String(error)}. Scroll up to retry.`,
		);
		this.mode.ui.requestRender();
	}
	private painted(page: MountedPage): boolean {
		const first = page.children[0],
			last = page.children.at(-1);
		if (!first || !last) return false;
		const from = this.chat.windowRowSpan(first),
			to = this.chat.windowRowSpan(last);
		return (
			!!from && !!to && from.top < this.view.scrollTop + this.view.viewportHeight && to.bottom > this.view.scrollTop
		);
	}
	private drop(page: MountedPage): void {
		for (const child of page.children) {
			this.chat.removeChild(child);
			if (!this.exceptions.protect(child)) disposeRenderer(child);
		}
		this.counter?.historyPrepended(-page.children.filter(isChatMessageComponent).length);
	}
	private clearPages(): void {
		for (const page of this.pages.splice(0)) this.drop(page);
	}
	private cancel(): void {
		this.pending?.abort();
		this.pending = undefined;
	}
	dispose(): void {
		this.cancel();
		this.clearPages();
		this.chat.removeChild(this.marker);
		this.view.setHistoryNavigation();
	}
}
