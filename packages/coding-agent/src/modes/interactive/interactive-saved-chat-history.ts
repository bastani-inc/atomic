import {
	type Component,
	Container,
	type HistoryLeaf,
	type HistoryRowsBlock,
	type ScrollView,
	Text,
	TuiAltScreen,
	WindowedContainer,
} from "@bastani/atomic-tui";
import type { SessionEntry, SessionManager } from "../../core/session-manager.ts";
import { chatPosition } from "../../core/storage/session/chat-records.js";
import type {
	SessionHistoryItem,
	SessionHistoryPage,
	SessionHistoryReadOptions,
} from "../../core/storage/session/types.js";
import { rowSource, savedRowKey, savedSeqOf } from "../../core/tasks/transcript-origin.js";
import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.js";
import { boundChatLayout, ChatReaderLayout, chatDecorationRow } from "./chat-reader-layout.js";
import {
	type ChatMount,
	type ChatPageDecorations,
	readMountedAnchors,
	sessionChatMount,
} from "./chat-reader-records.js";
import { parkedRun } from "./components/parked-rows.ts";
import { SavedRendererInstances } from "./components/saved-renderer-instances.js";

export type { SavedRendererInstances } from "./components/saved-renderer-instances.js";

import type { NewMessageCounter } from "./components/jump-to-latest.ts";
import { disposeRenderer } from "./components/renderer-disposal.js";
import { type InteractiveModeBase, isChatMessageComponent } from "./interactive-mode-base.ts";
import { withOversizedToolResults } from "./interactive-saved-tool-calls.ts";
import { StartupChatContainer } from "./interactive-startup-chat-container.ts";

type Direction = "older" | "newer" | "start" | "end";
type Draw = (
	mode: InteractiveModeBase,
	entries: SessionEntry[],
	seqs: number[],
	exceptions: SavedRendererInstances,
	adjacent: { readonly older?: string; readonly newer?: string } | undefined,
	copy?: SavedCopyDraw,
	records?: SavedPageRecords,
	earlier?: SavedPageEarlier,
) => Component[];

/**
 * The saved entries right before a page, in order, for its first replies' warnings: a prompt-cache miss and dropped
 * thinking compare a reply with the request and reply before it, which may be on the page before. `root`: nothing
 * is saved before them on the branch.
 */
export interface SavedPageEarlier {
	readonly entries: readonly SessionEntry[];
	readonly root: boolean;
}

/** At most this many saved entries before a page are read for its first replies: one turn's reply, results and prompt. */
const EARLIER_ENTRIES = 16;

/**
 * One bounded read of the entries right before a page, made only when its replies' warnings are shown. A reply whose
 * predecessor the read does not reach draws no warning that depends on it, as the whole chat does without one.
 */
async function readEarlierEntries(
	mode: InteractiveModeBase,
	manager: SessionManager,
	leaf: number,
	entries: readonly SessionEntry[],
	first: number | undefined,
	signal?: AbortSignal,
): Promise<SavedPageEarlier | undefined> {
	if (first === undefined || !mode.settingsManager.getShowCacheMissNotices()) return undefined;
	if (!entries.some((entry) => entry.type === "message" && entry.message.role === "assistant")) return undefined;
	if (first <= 1) return { entries: [], root: true };
	const read = manager.readHistory({
		branchLeafSeq: leaf,
		toSeq: first - 1,
		direction: "backward",
		limit: EARLIER_ENTRIES,
		signal,
	});
	try {
		const next = await read.next();
		if (next.done) return { entries: [], root: true };
		return { entries: next.value.items.map(entryForDisplay), root: next.value.nextCursor === undefined };
	} finally {
		await read.return();
	}
}

/** The saved reader-only lines of one page's entries, read with the page and drawn with it, as the whole chat
 * draws them. `root`: the page starts the conversation, so it also shows what was saved before any entry. */
export interface SavedPageRecords {
	readonly root: boolean;
	readonly data: ChatPageDecorations;
}

/** Read the saved lines of a page's entries with the page. They are not cached: they leave with its rows.
 * `back`: the page was read back, so the prompt it starts with may have overtaken notices ending the page before. */
async function readPageRecords(
	mode: InteractiveModeBase,
	manager: SessionManager,
	entries: SessionEntry[],
	root: boolean,
	back = false,
): Promise<SavedPageRecords | undefined> {
	if (mode.sessionManager !== manager || entries.length === 0) return undefined;
	const mount = sessionChatMount(mode, manager);
	if (!mount) return undefined;
	const positions = new ChatReaderLayout(entries, new Container(), { root });
	const targets = positions.orderTargets();
	if (back && chatPosition(entries[0]!).role === "prompt" && !targets.includes(entries[0]!.id))
		targets.push(entries[0]!.id);
	const data = await readMountedAnchors(
		{ scope: mount.scope, present: mount.present, records: new Map() },
		positions.anchors(),
		targets,
	);
	return data ? { root, data } : undefined;
}

/**
 * A prompt is drawn above the notices that overtook it on their way to storage (#5682) by a page holding both, so a
 * page does not end between them: read on, it stops before such notices when their prompt is past its end; read back,
 * it starts after such a prompt when their first notice is before its start. The next read continues from that edge.
 * A page keeps at least one entry, so a run longer than a page stays where the store cut it.
 */
function keepOvertakenRuns(
	direction: Direction,
	items: readonly SessionHistoryItem[],
	before: ReadonlyMap<string, string> | undefined,
): readonly SessionHistoryItem[] {
	if (!before?.size || items.length < 2) return items;
	const at = items.map((item) => chatPosition(entryForDisplay(item)));
	const ids = new Set(at.map((position) => position.id));
	const linked = (i: number) => at[i]!.parentId === at[i - 1]!.id;
	if (direction === "older") {
		let prompt = 0;
		while (at[prompt]?.role === "notice" && (prompt === 0 || linked(prompt))) prompt++;
		const first = at[prompt];
		if (first?.role !== "prompt" || (prompt > 0 && !linked(prompt)) || prompt + 1 >= items.length) return items;
		for (const [anchor, id] of before) if (id === first.id && !ids.has(anchor)) return items.slice(prompt + 1);
		return items;
	}
	let start = at.length - 1;
	if (at[start]!.role !== "notice") return items;
	while (start > 1 && at[start - 1]!.role === "notice" && linked(start)) start--;
	for (let i = start; i < at.length; i++) {
		const prompt = before.get(at[i]!.id);
		if (prompt !== undefined && !ids.has(prompt)) return items.slice(0, i);
	}
	return items;
}

/** Saved entries drawn for a copy, not mounted: where each row belongs, and the reads its edge cards still need. */
export interface SavedCopyDraw {
	readonly positions: Map<Component, HistoryLeaf>;
	/** Whether what the copy reads still belongs to the saved history shown. */
	readonly alive: () => boolean;
	readonly edges: { older?: SessionHistoryReadOptions; newer?: SessionHistoryReadOptions };
	settled?: Promise<void>;
}

const exceptionsByHost = new WeakMap<
	InteractiveModeBase,
	{ owner: object; id: string; exceptions: SavedRendererInstances }
>();

// A compaction refresh may replace the engine's local SessionManager, but not the engine that owns its widgets.
function widgetOwner(mode: InteractiveModeBase): object {
	return mode.runtimeHost instanceof IsolatedInteractiveRuntime ? mode.runtimeHost : mode.sessionManager;
}
function sessionRenderers(mode: InteractiveModeBase): SavedRendererInstances {
	const owner = widgetOwner(mode),
		id = mode.sessionManager.getSessionId();
	let kept = exceptionsByHost.get(mode);
	if (!kept || kept.owner !== owner || kept.id !== id) {
		kept?.exceptions.dispose();
		kept = { owner, id, exceptions: new SavedRendererInstances() };
		exceptionsByHost.set(mode, kept);
	}
	return kept.exceptions;
}

/** A tool's saved card belongs to its result even when a page ends between the call and result. */
export function widgetKey(row: object): string | undefined {
	const source = rowSource(row);
	const result = savedSeqOf(source?.result);
	if (result !== undefined) return `${result}:0`;
	if (source && "type" in source.message && source.message.type === "custom") {
		const seq = savedSeqOf(source.message);
		return seq === undefined ? undefined : `${seq}:entry`;
	}
	return savedRowKey(row);
}

export function storedWidget(mode: InteractiveModeBase, key: string | undefined): Component | undefined {
	return key === undefined ? undefined : exceptionsByHost.get(mode)?.exceptions.get(key)?.find(isChatMessageComponent);
}
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
		old !== undefined && (old.owner !== widgetOwner(mode) || old.id !== mode.sessionManager.getSessionId());
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
	const history = new SavedChatHistory(mode, manager, chat, view, draw, leaf, first - 1, sessionRenderers(mode));
	if (parked && parked.last < first) history.park(parked);
	mounts.set(mode, history);
}

/** The context the chat last drew: its boundary and the last saved sequence in it. */
const shownContexts = new WeakMap<
	InteractiveModeBase,
	{ owner: WeakRef<object>; id: string; boundary: string | undefined; through: number }
>();
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
	shownContexts.set(mode, { owner: new WeakRef(widgetOwner(mode)), id, boundary, through });
}

function changedBoundary(mode: InteractiveModeBase, context: readonly SessionEntry[]): number | undefined {
	const shown = shownContexts.get(mode),
		boundary = context[0],
		manager = mode.sessionManager;
	if (
		!shown ||
		shown.owner.deref() !== widgetOwner(mode) ||
		shown.id !== manager.getSessionId() ||
		boundary?.type !== "compaction" ||
		shown.boundary === boundary.id
	)
		return undefined;
	const seq = manager.getEntrySeq?.(boundary.id);
	return seq !== undefined && seq > shown.through ? seq : undefined;
}

/** Only stateful widgets survive a live clear outside the parked screen. Record the ones on screen as well, so they
 * can leave and reenter their saved page without losing local state later. The session itself never stores a widget. */
export function holdCompactionWidgets(
	mode: InteractiveModeBase,
	context: readonly SessionEntry[],
	parked?: ParkedViewport,
): void {
	if (mode.ui.mode !== "fullscreen" || changedBoundary(mode, context) === undefined) return;
	const store = sessionRenderers(mode);
	const remember = (row: Component) => {
		const key = widgetKey(row);
		return key !== undefined && store.rememberLive(key, row);
	};
	for (const row of parked?.parked?.rows ?? []) remember(row);
	for (const row of parked?.adopted ?? []) remember(row);
	// clear() disposes mounted engine renderers. Detach the widgets whose saved occurrence still owns them first.
	mode.chatContainer.children = mode.chatContainer.children.filter((row) => !(remember(row) && store.protect(row)));
}

/** What the next drawing of a context does with the rows a parked reader sees. */
export interface ParkedViewport {
	/** Rows of the retired window, mounted as a page above the new context. */
	readonly parked: ParkedRows | undefined;
	/** Rows of entries the new context keeps, in order, which its drawing puts where the first of them belongs. */
	readonly adopted: readonly Component[];
	/** The adopted rows by saved row key, `${seq}:${part}`. */
	readonly keys: ReadonlyMap<string, Component>;
	/** Anchors whose saved lines the kept rows show: the new context does not draw them again. */
	readonly shownRecords?: ReadonlySet<string>;
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
	if (mode.ui.mode !== "fullscreen" || !view || view.isFollowingEnd || !(chat instanceof StartupChatContainer))
		return undefined;
	const boundarySeq = changedBoundary(mode, context);
	if (boundarySeq === undefined) return undefined;
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
	const retired = withRecordRows(
		children,
		run.retired.filter((child) => !fixed.has(child)),
	);
	const kept = withRecordRows(
		children,
		run.adopted.filter((child) => !fixed.has(child)),
	);
	const adopted = new Map<string, Component>();
	for (const child of kept) {
		const key = savedRowKey(child);
		if (key !== undefined && !adopted.has(key)) adopted.set(key, child);
	}
	const moving = new Set([...retired, ...kept]);
	if (mode.ui instanceof TuiAltScreen) {
		const start = chat.windowRowSpan(children[first]!)?.top;
		if (start !== undefined) mode.ui.keepScrollPinnedPrompt(start, bottom);
	}
	mounts.get(mode)?.keep(moving);
	for (const child of moving) chat.removeChild(child);
	const shown = new Set<string>();
	for (const child of [...retired, ...kept]) {
		const record = chatDecorationRow(child);
		if (record) shown.add(record.id);
	}
	for (const id of readKeptLines(mode, moving, shown)) shown.add(id);
	return {
		parked: retired.length ? { rows: retired, first: run.first, last: run.last } : undefined,
		adopted: kept,
		keys: adopted,
		shownRecords: shown,
	};
}

/**
 * A saved line whose read was still in flight when the compaction came was never drawn: the drawing that read it is
 * cleared. Read again the lines of the rows the reader keeps that show none yet, bounded to those rows, and draw each
 * after its row as that drawing would have, in the page those rows form or in the new context that adopts them.
 * Returns the anchors read, which the new context then leaves to these rows, as it does the lines they show.
 */
function readKeptLines(mode: InteractiveModeBase, rows: ReadonlySet<Component>, shown: ReadonlySet<string>): string[] {
	const layout = boundChatLayout(mode);
	const mount = layout && sessionChatMount(mode, mode.sessionManager);
	const anchors = (mount && layout?.anchorsAfter(rows, shown)) || [];
	if (!mount || !layout || !anchors.length) return [];
	// The lines leave with their rows, as a saved page's do: an answer already read is used, nothing is cached.
	const records: ChatMount["records"] = new Map();
	for (const id of anchors) {
		const known = mount.records.get(id);
		if (known) records.set(id, known);
	}
	const chat = mode.chatContainer;
	void readMountedAnchors({ scope: mount.scope, present: mount.present, records }, anchors).then((data) => {
		if (!data?.after.size || mode.chatContainer !== chat) return;
		const drawn = new Set(chat.children);
		if (!layout.apply(chat, { after: data.after, before: new Map() })) return;
		mounts.get(mode)?.joinLines(chat.children.filter((child) => !drawn.has(child)));
		mode.ui.requestRender();
	});
	return anchors;
}

/**
 * The rows of one part of a parked view with the reader-only lines that belong to them: a line drawn after one of
 * their rows, including those just below the last one, stays with them. Any other line in the part belongs to the
 * rows next to it, which are drawn again past an edge or by the new context, with that line.
 */
function withRecordRows(children: readonly Component[], part: readonly Component[]): Component[] {
	if (!part.length) return [];
	const rows = new Set(part.filter((child) => !chatDecorationRow(child)));
	const keeps = (child: Component, previous: Component | undefined) => {
		const record = chatDecorationRow(child)!;
		return record.after ? rows.has(record.after) : previous !== undefined && rows.has(previous);
	};
	const result: Component[] = [];
	let previous: Component | undefined;
	for (const child of part) {
		if (!chatDecorationRow(child)) previous = child;
		else if (!keeps(child, previous)) continue;
		result.push(child);
	}
	const last = part.at(-1)!;
	for (let i = children.indexOf(last) + 1; i < children.length; i++) {
		const child = children[i]!;
		if (!chatDecorationRow(child) || !keeps(child, previous)) break;
		result.push(child);
	}
	return result;
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

interface VisiblePage {
	readonly page: SessionHistoryPage;
	readonly records?: SavedPageRecords;
	readonly earlier?: SavedPageEarlier;
}

async function readVisiblePage(
	mode: InteractiveModeBase,
	manager: SessionManager,
	leaf: number,
	options: SessionHistoryReadOptions,
	direction: Direction,
): Promise<VisiblePage | undefined> {
	const read = manager.readHistory(options);
	let page: SessionHistoryPage | undefined;
	try {
		const next = await read.next();
		page = next.done ? undefined : next.value;
	} finally {
		await read.return();
	}
	if (!page) return undefined;
	page = await withOversizedToolResults(manager, page, options.signal);
	options.signal?.throwIfAborted();
	// The page's saved lines and the entries before it arrive with it, so it is drawn once, as the whole chat draws it.
	const entries = page.items.map(entryForDisplay),
		first = page.items[0]?.seq;
	const [records, earlier] = await Promise.all([
		readPageRecords(mode, manager, entries, first === 1, direction === "older"),
		readEarlierEntries(mode, manager, leaf, entries, first, options.signal),
	]);
	return { page, records, earlier };
}

/** Network I/O owns only its abort signal and a weak return address, not the terminal and every rendered row. */
function requestPage(
	owner: WeakRef<SavedChatHistory>,
	signal: AbortSignal,
	direction: Direction,
	range: { readonly from: number; readonly to: number },
	read: Promise<VisiblePage | undefined>,
): void {
	void read.then(
		(page) => {
			if (!signal.aborted) owner.deref()?.publish(direction, page?.page, range, page?.records, page?.earlier);
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
	private readonly lifetime = new AbortController();
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
		// A copy of a selection that holds saved entries never mounted while it was made draws just those entries.
		const owner = new WeakRef(this);
		WindowedContainer.markHistoryAnchor(this.marker, exceptions.source, {
			last: through,
			read: async (from, to, width) => {
				const history = owner.deref();
				if (!history) throw new Error("Saved history is closed");
				return history.readRows(from, to, width);
			},
		});
		view.setHistoryNavigation((action) => this.navigate(action));
	}

	/**
	 * Draw the saved rows of entries `from` through `to` at `width` for a copy, as the whole transcript draws them,
	 * without mounting them or keeping new renderer instances. Release each page before reading the next; only the
	 * selected output accumulates. A cut tool pair reads individually past the page edge to place its card at the call.
	 */
	async readRows(from: number, to: number, width: number): Promise<HistoryRowsBlock[]> {
		const alive = () => this.mode.sessionManager === this.manager && this.chat.children.includes(this.marker);
		const closed = () => new Error("Saved history is no longer shown");
		if (!alive()) throw closed();
		const last = Math.min(to, this.through);
		if (from > last) return [];
		const blocks: HistoryRowsBlock[] = [];
		const branchLeafSeq = this.leaf,
			signal = this.lifetime.signal;
		for await (const page of this.manager.readHistory({
			branchLeafSeq,
			fromSeq: Math.max(1, from),
			toSeq: last,
			direction: "forward",
			signal,
		})) {
			if (!alive()) throw closed();
			const { items } = await withOversizedToolResults(this.manager, page, signal);
			if (!alive()) throw closed();
			const entries = items.map(entryForDisplay),
				first = items[0]?.seq,
				end = items.at(-1)?.seq;
			const [records, earlier] = await Promise.all([
				readPageRecords(this.mode, this.manager, entries, first === 1),
				readEarlierEntries(this.mode, this.manager, branchLeafSeq, entries, first, signal),
			]);
			if (!alive()) throw closed();
			if (first === undefined || end === undefined) continue;
			const copy: SavedCopyDraw = {
				positions: new Map(),
				alive,
				edges: {
					...(first > 1 ? { older: { branchLeafSeq, toSeq: first - 1, direction: "backward", signal } } : {}),
					...(end < this.through
						? { newer: { branchLeafSeq, fromSeq: end + 1, toSeq: this.through, direction: "forward", signal } }
						: {}),
				},
			};
			const components = this.draw(
				this.mode,
				entries,
				items.map((item) => item.seq),
				this.exceptions,
				undefined,
				copy,
				records,
				earlier,
			);
			try {
				await copy.settled;
				if (!alive()) throw closed();
				for (const component of components) {
					const position = copy.positions.get(component);
					if (position) blocks.push({ position, lines: component.render(width) });
				}
			} finally {
				for (const component of components) if (!this.exceptions.keeps(component)) disposeRenderer(component);
			}
		}
		return blocks;
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
			readVisiblePage(
				this.mode,
				this.manager,
				this.leaf,
				{ ...request.options, adjacent: true, signal: controller.signal },
				direction,
			),
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
		this.markParked(children);
		this.chat.insertChildren(this.chat.children.indexOf(this.marker) + 1, children);
		this.pages.push({ children, first: parked.first, last: parked.last, from: parked.first, to: parked.last });
	}

	/** Saved lines drawn after rows of a parked page once it is mounted join that page, where they are drawn. */
	joinLines(lines: readonly Component[]): void {
		for (let index = 0; index < this.pages.length; index++) {
			const page = this.pages[index]!;
			const rows = new Set(page.children);
			const joining = new Set(
				lines.filter((line) => {
					const after = chatDecorationRow(line)?.after;
					return after !== undefined && rows.has(after);
				}),
			);
			if (!joining.size) continue;
			const children = this.chat.children.filter((child) => rows.has(child) || joining.has(child));
			this.markParked(children);
			this.pages[index] = { ...page, children };
		}
	}

	/**
	 * Parked rows are saved rows, marked as a drawn page marks them: a row without a saved source (a spacer, a
	 * decoration) belongs to the entry of the next row that has one, as it was drawn before that row, and rows after
	 * the last such row follow it.
	 */
	private markParked(children: readonly Component[]): void {
		const source = this.exceptions.source;
		let pending: Component[] = [];
		let at: { seq: number; block: number; parts: number } | undefined;
		for (const row of children) {
			pending.push(row);
			const key = savedRowKey(row);
			if (key === undefined) continue;
			const [seq, block] = key.split(":");
			at = { seq: Number(seq), block: block === "entry" ? 0 : Number(block), parts: pending.length };
			for (let part = 0; part < pending.length; part++)
				WindowedContainer.markHistoryComponent(pending[part]!, source, at.seq, at.block, part);
			pending = [];
		}
		if (at)
			for (let index = 0; index < pending.length; index++)
				WindowedContainer.markHistoryComponent(pending[index]!, source, at.seq, at.block, at.parts + index);
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
		records?: SavedPageRecords,
		earlier?: SavedPageEarlier,
	): void {
		this.pending = undefined;
		const at = this.chat.children.indexOf(this.marker);
		if (!page || at < 0 || this.mode.sessionManager !== this.manager) return;
		if (direction === "start") this.clearPages();
		const items = keepOvertakenRuns(direction, page.items, records?.data.before);
		const older = items[0] === page.items[0],
			newer = items.at(-1) === page.items.at(-1);
		const children = this.draw(
			this.mode,
			items.map(entryForDisplay),
			items.map((item) => item.seq),
			this.exceptions,
			page.adjacent,
			undefined,
			records,
			earlier,
		);
		// An edge cut short continues with a range read from the page's own edge, not with the store's cursor.
		const mounted: MountedPage = {
			children,
			older: older ? page.adjacent?.older : undefined,
			newer: newer ? page.adjacent?.newer : undefined,
			first: items[0]?.seq ?? range.from,
			last: items.at(-1)?.seq ?? range.to,
			from: older ? range.from : items[0]!.seq,
			to: newer ? range.to : items.at(-1)!.seq,
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
		this.lifetime.abort();
		this.cancel();
		this.clearPages();
		this.chat.removeChild(this.marker);
		this.view.setHistoryNavigation();
	}
}
