import { type Component, type Container, Spacer, Text } from "@bastani/atomic-tui";
import type { SessionEntry } from "../../core/session-manager-types.ts";
import { type ChatPosition, chatPosition } from "../../core/storage/session/chat-records.js";
import { stripTerminalControls } from "../../utils/ansi.js";
import { type ChatMount, type ChatPageDecorations, readMountedAnchors } from "./chat-reader-records.js";
import type { StartupChatContainer } from "./interactive-startup-chat-container.ts";
import { theme } from "./theme/theme.js";

const currentLayouts = new WeakMap<object, WeakRef<ChatReaderLayout>>();
export function bindChatLayout(view: object, layout: ChatReaderLayout): void {
	currentLayouts.set(view, new WeakRef(layout));
}
export function chatLineDrawnLive(view: object, id: string): void {
	currentLayouts.get(view)?.deref()?.live.add(id);
}
/** The layout of the chat a view last drew, while it is alive. */
export function boundChatLayout(view: object): ChatReaderLayout | undefined {
	return currentLayouts.get(view)?.deref();
}
/** A reader-only row a layout drew: the anchor it shows a line of, and the row it follows (absent at the start). */
export interface ChatDecorationRow {
	readonly id: string;
	readonly after?: Component;
}
const decorationRows = new WeakMap<Component, ChatDecorationRow>();
/** Where a reader-only row belongs, if the row is one. */
export function chatDecorationRow(row: Component): ChatDecorationRow | undefined {
	return decorationRows.get(row);
}
/** Rows a live event drew for a saved line, which then also stand for that line's record. */
export function noteLiveChatRows(rows: readonly Component[], id: string): void {
	for (const row of rows) if (!decorationRows.has(row)) decorationRows.set(row, { id });
}
type Span = { first: Component; last: Component };
type StoredSpan = { first: WeakRef<Component>; last: WeakRef<Component>; trailing?: boolean };
type Position = ChatPosition & { group?: number; orderTarget?: string };
type WindowConsumer = ((child: Component) => void) & { paint: (data: ChatPageDecorations) => void };
// A stalled optional read retains the requested IDs, not the chat, its component tree, or a stale scroll view.
function deliver(read: Promise<ChatPageDecorations | undefined>, consumer: WeakRef<WindowConsumer>): void {
	void read.then((data) => {
		if (data) consumer.deref()?.paint(data);
	});
}
function discoverWindow(present: Promise<boolean>, token: WeakRef<{ ready: (found: boolean) => void }>): void {
	void present.then((found) => token.deref()?.ready(found));
}

/** A paint records where each contributing source occurrence ended. A late decoration uses those exact rows,
 * rather than rerunning renderers, matching display text, or replacing live work that arrived in the meantime. */
export class ChatReaderLayout {
	private groups = new Map<string, number>();
	private tokens = new WeakMap<object, number>();
	private nextToken = 0;
	private spans = new Map<number, StoredSpan>();
	private trailing = new WeakSet<object>();
	private atComponent = new WeakMap<Component, number>();
	private byId?: Map<string, Position>;
	private original?: readonly SessionEntry[];
	private pendingMoves = new Map<number, Component[]>();
	private readonly queried = new Set<string>();
	readonly live = new Set<string>();
	/** Anchors whose rows are already shown, kept from before this layout; it does not draw them again. */
	private readonly shown = new Set<string>();
	private root?: WeakRef<Component>;
	private hasRoot: boolean;
	/** `root`: whether `source` starts the conversation (a saved page says so; a context starting with a boundary
	 * does not). */
	constructor(source: readonly SessionEntry[], chat: Container, options: { readonly root?: boolean } = {}) {
		this.original = source;
		this.hasRoot = options.root ?? source[0]?.type !== "compaction";
		const root = chat.children.at(-1);
		if (root) this.root = new WeakRef(root);
	}
	/** Anchors already shown by rows a parked reader kept. */
	keepShown(ids: Iterable<string>): void {
		for (const id of ids) this.shown.add(id);
	}
	/** Anchors whose saved lines this layout draws after one of `rows`, other than `except`. */
	anchorsAfter(rows: ReadonlySet<Component>, except: ReadonlySet<string>): string[] {
		const groups = new Set<number>();
		for (const [group, span] of this.spans) {
			const last = span.last.deref();
			if (last && rows.has(last)) groups.add(group);
		}
		if (!groups.size) return [];
		return [...this.index().values()].flatMap((p) =>
			p.group !== undefined && groups.has(p.group) && !except.has(p.id) ? [p.id] : [],
		);
	}
	/** Every prompt a notice run of these entries can show ahead of it, for a read of the whole page at once. */
	orderTargets(): string[] {
		return [...new Set([...this.index().values()].flatMap((p) => (p.orderTarget ? [p.orderTarget] : [])))];
	}
	private index(): Map<string, Position> {
		if (this.byId) return this.byId;
		const positions = new Map<string, Position>();
		let group: number | undefined;
		for (const entry of this.original ?? []) {
			group = this.groups.get(entry.id) ?? group;
			positions.set(entry.id, { ...chatPosition(entry), group });
		}
		this.original = undefined;
		// Only an unbroken run of excluded notices immediately before a prompt could have overtaken it.
		// Bind its prompt once, without re-reading the notices (or their message bodies) on each frame.
		let next: Position | undefined;
		for (const p of Array.from(positions.values()).reverse()) {
			if (p.role === "notice" && next?.parentId === p.id)
				p.orderTarget = next.role === "prompt" ? next.id : next.orderTarget;
			if (p.orderTarget && next?.role === "prompt") next.orderTarget = next.id;
			next = p;
		}
		this.byId = positions;
		return positions;
	}
	anchors(): string[] {
		return [...(this.hasRoot ? [""] : []), ...this.index().keys()];
	}
	observeWindowWhenPresent(chat: StartupChatContainer, mount: ChatMount, request: () => void): void {
		if (typeof mount.present === "boolean") {
			if (mount.present) this.observeWindow(chat, mount, request);
			return;
		}
		// No fullscreen frame waits. Closing or switching clears this receiver; an unresponsive adapter
		// cannot keep the old chat alive, and a slow positive answer can still decorate a mounted chat.
		const receiver = Object.assign(() => {}, {
			ready: (found: boolean) => {
				if (chat.onVisibleChild !== receiver) return;
				if (found) this.observeWindow(chat, mount, request);
				else chat.onVisibleChild = undefined;
			},
		});
		chat.onVisibleChild = receiver;
		discoverWindow(mount.present, new WeakRef(receiver));
	}
	private observeWindow(chat: StartupChatContainer, mount: ChatMount, request: () => void): void {
		const groups = new Map<number, string[]>();
		const leading: string[] = this.hasRoot ? [""] : [];
		for (const p of this.index().values()) {
			if (p.group === undefined) {
				leading.push(p.id);
				continue;
			}
			const ids = groups.get(p.group);
			if (ids) ids.push(p.id);
			else groups.set(p.group, [p.id]);
		}
		const first = groups.keys().next().value;
		if (first !== undefined && leading.length) groups.set(first, leading.concat(groups.get(first)!));
		const queued = new Set<string>();
		const submit = (ids: readonly string[]) => {
			const schedule = !queued.size;
			for (const id of ids)
				if (!this.queried.has(id)) {
					this.queried.add(id);
					queued.add(id);
				}
			if (!schedule || !queued.size) return;
			queueMicrotask(() => {
				if (chat.onVisibleChild !== consume) return;
				const slice = [...queued];
				queued.clear();
				const targets = [
					...new Set(
						slice.flatMap((id) => {
							const t = this.index().get(id)?.orderTarget;
							return t ? [t] : [];
						}),
					),
				];
				deliver(readMountedAnchors(mount, slice, targets), new WeakRef(consume));
			});
		};
		const consume: WindowConsumer = Object.assign(
			(child: Component) => {
				const group = this.atComponent.get(child),
					ids = group === undefined ? undefined : groups.get(group);
				if (ids) submit(ids);
			},
			{
				paint: (data: ChatPageDecorations) => {
					if (chat.onVisibleChild === consume && this.apply(chat, data)) request();
				},
			},
		);
		chat.onVisibleChild = consume;
		if (first === undefined) submit(leading); // A cancelled empty chat has no primary row to paint.
		request();
	}
	/** A billing component follows the boundary row if the reader chose to show costs. If no component is drawn,
	 * the boundary's own last row remains its anchor. */
	extendGroup(id: string, end: object): void {
		const token = this.groups.get(id);
		if (token === undefined) this.bind(id, end);
		else this.tokens.set(end, token);
		this.trailing.add(end);
	}
	bind(id: string, last: object | undefined): void {
		if (!last) return;
		let token = this.tokens.get(last);
		if (token === undefined) {
			token = ++this.nextToken;
			this.tokens.set(last, token);
		}
		this.groups.set(id, token);
	}
	paint(group: object, chat: Container, start: number): void {
		const token = this.tokens.get(group);
		if (token === undefined) return;
		const first = chat.children[start],
			last = chat.children.at(-1);
		if (!first || !last) return;
		const previous = this.spans.get(token),
			trailing = this.trailing.has(group);
		this.spans.set(token, {
			first: trailing && previous ? previous.first : new WeakRef(first),
			last: !trailing && previous?.trailing ? previous.last : new WeakRef(last),
			trailing: trailing || previous?.trailing,
		});
		this.atComponent.set(last, token);
		const preceding = this.pendingMoves.get(token);
		if (preceding) {
			this.pendingMoves.delete(token);
			chat.children.splice(start, 0, ...preceding);
		}
	}
	private span(group: number | undefined): Span | undefined {
		if (group === undefined) return undefined;
		const s = this.spans.get(group),
			first = s?.first.deref(),
			last = s?.last.deref();
		return first && last ? { first, last } : undefined;
	}
	apply(chat: Container, data: ChatPageDecorations): boolean {
		const index = this.index();
		let changed = false;
		for (const [notice, prompt] of data.before) {
			const from = index.get(notice),
				to = index.get(prompt);
			if (!from || from.group === undefined || from.orderTarget !== prompt || to?.role !== "prompt") continue;
			const p = this.span(to.group),
				n = this.span(from.group);
			if (!p) continue;
			const begin = chat.children.indexOf(p.first),
				end = chat.children.indexOf(p.last);
			if (begin < 0 || end < begin || end - begin > 1) continue;
			const at = n ? chat.children.indexOf(n.first) : -1;
			if (at >= begin || (at < 0 && this.spans.has(from.group))) continue;
			const rows = chat.children.splice(begin, end - begin + 1);
			if (at < 0) this.pendingMoves.set(from.group, rows);
			else chat.children.splice(at, 0, ...rows);
			changed = true;
		}
		const added = new Map<Component | undefined, Component[]>();
		for (const [id, lines] of data.after) {
			const p = index.get(id);
			if ((id !== "" && !p) || this.shown.has(id)) continue;
			const anchor = p?.group !== undefined ? this.span(p.group)?.last : this.root?.deref();
			if (p?.group !== undefined && !anchor) continue;
			const group = added.get(anchor) ?? [];
			const row: ChatDecorationRow = p?.group !== undefined && anchor ? { id, after: anchor } : { id };
			for (const line of lines)
				if (!line.id || !this.live.has(line.id)) {
					const spacer = new Spacer(1),
						text = new Text(theme.fg(line.level, stripTerminalControls(line.text)), 1, 0);
					decorationRows.set(spacer, row);
					decorationRows.set(text, row);
					group.push(spacer, text);
				}
			if (group.length) added.set(anchor, group);
		}
		if (added.size) {
			const next = [...(added.get(undefined) ?? [])];
			for (const child of chat.children) {
				next.push(child);
				for (const extra of added.get(child) ?? []) next.push(extra);
			}
			chat.children = next;
			changed = true;
		}
		return changed;
	}
}
