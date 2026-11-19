import type { TaskChatPage } from "../../../core/tasks/task-chat-records.js";
import { chatMount, inDisplayOrder, readMountedAnchors } from "../chat-reader-records.js";
import { type ChatMessageEntry, type LiveChatEntriesController, taskDisplayLine } from "./chat-message-renderer.ts";

/** A mounted page holds its exact converted rows. A late read edits only those rows, never replacing a
 * newly published reply or borrowing positions from a different page/session. */
export class TaskChatDecoration {
	private visible = new WeakMap<object, () => void>();
	readonly live = new Set<string>();
	clear(): void {
		this.visible = new WeakMap();
		this.live.clear();
	}
	observe(entry: object): void {
		this.visible.get(entry)?.();
	}
	capture(
		view: object,
		page: TaskChatPage | undefined,
		controller: LiveChatEntriesController,
		render: () => void,
	): ((row: ChatMessageEntry | undefined) => void) | undefined {
		if (!page) return undefined;
		const mount = chatMount(view, page.scope);
		if (!mount) return undefined;
		const held = this.visible;
		const at = new Map<number, string[]>();
		for (const [id, index] of page.positions) {
			const ids = at.get(index) ?? [];
			ids.push(id);
			at.set(index, ids);
		}
		const byId = new Map<string, ChatMessageEntry>(),
			consumed = new Set<string>();
		const queue = new Set<string>();
		const flush = () => {
			if (this.visible !== held) return;
			const requested = [...queue];
			queue.clear();
			void readMountedAnchors(mount, () => requested).then((data) => {
				if (!data || this.visible !== held) return;
				const ordered = inDisplayOrder(page.entries, data.before);
				const moves = new Map<ChatMessageEntry, ChatMessageEntry>();
				for (let i = 0; i < ordered.length; i++) {
					const original = page.entries[i]!,
						next = ordered[i]!;
					if (data.before.get(original.id) !== next.id) continue;
					const from = byId.get(original.id),
						to = byId.get(next.id);
					if (from && to) moves.set(from, to);
				}
				const after = new Map<ChatMessageEntry | null, ChatMessageEntry[]>();
				for (const [id, lines] of data.after) {
					const row = id === "" ? null : byId.get(id);
					if (row !== undefined)
						after.set(row, lines.filter((line) => !line.id || !this.live.has(line.id)).map(taskDisplayLine));
				}
				if (controller.decorateRows(moves, after)) render();
			});
		};
		let index = 0;
		return (row) => {
			const ids = at.get(index++) ?? [];
			if (!row || !ids.length) return;
			for (const id of ids) byId.set(id, row);
			if (index === 1 && page.root) ids.push("");
			held.set(row, () => {
				const schedule = !queue.size;
				for (const id of ids)
					if (!consumed.has(id)) {
						consumed.add(id);
						queue.add(id);
					}
				if (schedule && queue.size) queueMicrotask(flush);
			});
		};
	}
}
