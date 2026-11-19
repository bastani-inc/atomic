import { type Component, type ScrollView, Text } from "@bastani/atomic-tui";
import type { SessionEntry, SessionManager } from "../../core/session-manager.ts";
import type {
	SessionHistoryItem,
	SessionHistoryPage,
	SessionHistoryReadOptions,
} from "../../core/storage/session/types.js";
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
	newer: boolean,
) => Component[];

const exceptionsByHost = new WeakMap<
	InteractiveModeBase,
	{ manager: SessionManager; id: string; exceptions: SavedRendererInstances }
>();
interface MountedPage {
	readonly children: Component[];
	readonly older?: string;
	readonly newer?: string;
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
export function installSavedChatHistory(mode: InteractiveModeBase, context: SessionEntry[], draw: Draw): void {
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
	mounts.set(mode, history);
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
	read: Promise<SessionHistoryPage | undefined>,
): void {
	void read.then(
		(page) => {
			if (!signal.aborted) owner.deref()?.publish(direction, page);
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
		const cursor = direction === "older" ? this.pages[0]?.older : this.pages.at(-1)?.newer;
		if ((direction === "newer" && !cursor) || (direction === "older" && this.pages.length && !cursor)) return;
		const top = this.view.scrollTop,
			height = this.view.viewportHeight;
		if (direction === "older" && top > (this.chat.windowRowSpan(this.marker)?.bottom ?? 1) + height) return;
		if (direction === "newer") {
			const last = this.pages.at(-1)?.children.at(-1);
			if (last && top + 2 * height < (this.chat.windowRowSpan(last)?.bottom ?? 0)) return;
		}
		const controller = new AbortController();
		this.pending = controller;
		const options: SessionHistoryReadOptions =
			direction === "start" || !cursor
				? {
						branchLeafSeq: this.leaf,
						toSeq: this.through,
						direction: direction === "start" ? "forward" : "backward",
					}
				: { cursor };
		requestPage(
			new WeakRef(this),
			controller.signal,
			direction,
			readVisiblePage(this.manager, { ...options, adjacent: true, signal: controller.signal }),
		);
	}

	publish(direction: Direction, page: SessionHistoryPage | undefined): void {
		this.pending = undefined;
		const at = this.chat.children.indexOf(this.marker);
		if (!page || at < 0 || this.mode.sessionManager !== this.manager) return;
		if (direction === "start") this.clearPages();
		const children = this.draw(
			this.mode,
			page.items.map(entryForDisplay),
			page.items.map((item) => item.seq),
			this.exceptions,
			page.adjacent?.newer !== undefined,
		);
		const mounted: MountedPage = { children, older: page.adjacent?.older, newer: page.adjacent?.newer };
		if (direction === "newer") {
			const previous = this.pages.at(-1)?.children.at(-1);
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
