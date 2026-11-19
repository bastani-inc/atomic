import { type Component, type Container, Spacer, Text } from "@bastani/atomic-tui";
import type { SessionEntry } from "../../core/session-manager-types.ts";
import { type ChatPosition, chatPosition } from "../../core/storage/session/chat-records.js";
import { stripTerminalControls } from "../../utils/ansi.js";
import { type ChatMount, type ChatPageDecorations, inDisplayOrder, readMountedAnchors } from "./chat-reader-records.js";
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
/** Source occurrences and the concrete components produced by this single synchronous paint. Neither a text
 * match nor a second invocation of an extension renderer can identify a row when a late optional read finishes. */
export class ChatReaderLayout {
	private groups = new Map<string, object>();
	private spans = new Map<object, Span>();
	private groupAnchors?: Map<object, string[]>;
	private atComponent = new WeakMap<Component, object>();
	private readonly drawn = new Set<string>();
	readonly live = new Set<string>();
	private base: Component | undefined;
	private original?: readonly SessionEntry[];
	private positions?: readonly ChatPosition[];
	private get source(): readonly ChatPosition[] {
		if (!this.positions && this.original) {
			this.positions = this.original.map(chatPosition);
			this.original = undefined;
		}
		return this.positions ?? [];
	}
	private readonly hasRoot: boolean;
	constructor(source: readonly SessionEntry[], container: Container) {
		this.original = source;
		this.hasRoot = source[0]?.type !== "compaction";
		this.base = container.children.at(-1);
	}
	anchors(): string[] {
		return [...(this.hasRoot ? [""] : []), ...this.source.map((entry) => entry.id)];
	}
	observeWindow(chat: StartupChatContainer, mount: ChatMount, request: () => void): void {
		const groups = new Map<object, string[]>();
		let group: object | undefined;
		const leading: string[] = this.hasRoot ? [""] : [];
		for (const entry of this.source) {
			group = this.groups.get(entry.id) ?? group;
			if (!group) {
				leading.push(entry.id);
				continue;
			}
			const ids = groups.get(group) ?? [];
			ids.push(entry.id);
			groups.set(group, ids);
		}
		const first = groups.values().next().value;
		if (first) first.unshift(...leading);
		this.groupAnchors = groups;
		const queued = new Set<string>();
		const consume = (child: Component) => {
			const group = this.atComponent.get(child);
			const ids = group && this.groupAnchors?.get(group);
			if (!ids) return;
			const schedule = queued.size === 0;
			for (const id of ids)
				if (!this.drawn.has(id)) {
					queued.add(id);
					this.drawn.add(id);
				}
			if (schedule && queued.size)
				queueMicrotask(() => {
					if (chat.onVisibleChild !== consume) return;
					const slice = [...queued];
					queued.clear();
					void readMountedAnchors(mount, () => slice).then((data) => {
						if (data && chat.onVisibleChild === consume && this.apply(chat, data)) request();
					});
				});
		};
		chat.onVisibleChild = consume;
		request();
	}
	bind(id: string, last: object | undefined): void {
		if (last) this.groups.set(id, last);
	}
	paint(group: object, chat: Container, start: number): void {
		const first = chat.children[start],
			last = chat.children.at(-1);
		if (first && last) {
			this.spans.set(group, { first, last });
			this.atComponent.set(last, group);
		}
	}
	private span(id: string): Span | undefined {
		const group = this.groups.get(id);
		return group && this.spans.get(group);
	}
	apply(chat: Container, data: ChatPageDecorations): boolean {
		const entries = inDisplayOrder(this.source, data.before);
		for (let i = 0; i < entries.length; i++) {
			const e = entries[i]!;
			if (e.role !== "prompt" || this.source[i] === e) continue;
			const target = this.source[i]!;
			if (data.before.get(target.id) !== e.id) continue;
			const prompt = this.span(e.id),
				notice = this.span(target.id);
			if (!prompt || !notice) continue;
			const at = chat.children.indexOf(notice.first),
				first = chat.children.indexOf(prompt.first),
				last = chat.children.indexOf(prompt.last);
			if (at < 0 || first <= at || last < first || last - first > 1) continue;
			// A user row owns at most its leading spacer and prompt. Never move a sibling inserted since the snapshot.
			const moved = chat.children.splice(first, last - first + 1);
			chat.children.splice(at, 0, ...moved);
		}
		const insertions = new Map<Component | undefined, Component[]>();
		let previous = this.base;
		const lines = (id: string) => {
			const notes = data.after.get(id);
			if (!notes) return;
			const group = insertions.get(previous) ?? [];
			for (const note of notes)
				if (!note.id || !this.live.has(note.id))
					group.push(new Spacer(1), new Text(theme.fg(note.level, stripTerminalControls(note.text)), 1, 0));
			insertions.set(previous, group);
		};
		lines("");
		for (const e of entries) {
			previous = this.span(e.id)?.last ?? previous;
			lines(e.id);
		}
		if (insertions.size) {
			const next: Component[] = [...(insertions.get(undefined) ?? [])];
			for (const child of chat.children) {
				next.push(child);
				for (const added of insertions.get(child) ?? []) next.push(added);
			}
			chat.children = next;
		}
		return data.before.size > 0 || insertions.size > 0;
	}
}
