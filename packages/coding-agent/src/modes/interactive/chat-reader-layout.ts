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
type Span = { first: Component; last: Component };
type StoredSpan = { first: WeakRef<Component>; last: WeakRef<Component> };
type Position = ChatPosition & { group?: number; orderTarget?: string };
type WindowConsumer = ((child: Component) => void) & { paint: (data: ChatPageDecorations) => void };
// A stalled optional read retains the requested IDs, not the chat, its component tree, or a stale scroll view.
function deliver(read: Promise<ChatPageDecorations | undefined>, consumer: WeakRef<WindowConsumer>): void {
	void read.then((data) => {
		if (data) consumer.deref()?.paint(data);
	});
}

/** A paint records where each contributing source occurrence ended. A late decoration uses those exact rows,
 * rather than rerunning renderers, matching display text, or replacing live work that arrived in the meantime. */
export class ChatReaderLayout {
	private groups = new Map<string, number>();
	private tokens = new WeakMap<object, number>();
	private nextToken = 0;
	private spans = new Map<number, StoredSpan>();
	private atComponent = new WeakMap<Component, number>();
	private byId?: Map<string, Position>;
	private original?: readonly SessionEntry[];
	private pendingMoves = new Map<number, Component[]>();
	private readonly queried = new Set<string>();
	readonly live = new Set<string>();
	private root?: WeakRef<Component>;
	private hasRoot: boolean;
	constructor(source: readonly SessionEntry[], chat: Container) {
		this.original = source;
		this.hasRoot = source[0]?.type !== "compaction";
		const root = chat.children.at(-1);
		if (root) this.root = new WeakRef(root);
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
	observeWindow(chat: StartupChatContainer, mount: ChatMount, request: () => void): void {
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
		this.spans.set(token, { first: new WeakRef(first), last: new WeakRef(last) });
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
			if (id !== "" && !p) continue;
			const anchor = p?.group !== undefined ? this.span(p.group)?.last : this.root?.deref();
			if (p?.group !== undefined && !anchor) continue;
			const group = added.get(anchor) ?? [];
			for (const line of lines)
				if (!line.id || !this.live.has(line.id))
					group.push(new Spacer(1), new Text(theme.fg(line.level, stripTerminalControls(line.text)), 1, 0));
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
