import type { ChatPosition } from "../../../core/storage/session/chat-records.js";
import type { TaskChatPage } from "../../../core/tasks/task-chat-records.js";
import {
	type ChatMount,
	type ChatPageDecorations,
	chatMount,
	inDisplayOrder,
	readMountedAnchors,
} from "../chat-reader-records.js";
import { type ChatMessageEntry, type LiveChatEntriesController, taskDisplayLine } from "./chat-message-renderer.ts";

type Row = ChatMessageEntry;
/** The rows one adopted page converted, and which of its source rows each holds. */
interface PageRows {
	readonly page: TaskChatPage;
	readonly mount: ChatMount;
	/** Where an owned source row's lines go: after a row, or (null) ahead of the page's first row. */
	readonly at: Map<string, Row | null>;
	/** The row a prompt or notice draws itself, which a recorded order can move. */
	readonly own: Map<string, Row>;
	/** What this page asked for, and what its next read asks for. */
	readonly asked: { readonly anchors: Set<string>; readonly orders: Set<string> };
	readonly anchors: Set<string>;
	readonly orders: Set<string>;
	first?: Row;
	/** Each prompt reached by a parent-linked notice run, by the prompt and by every notice of its run. */
	runs?: Map<string, string>;
}
/** One adopted transcript, its pages from the top. Replacing or closing it drops it; a read that is still on its way
 * holds it only weakly, so a store that never answers keeps neither the rows nor the chat. */
class Adopted {
	readonly pages: PageRows[] = [];
	readonly shown = new WeakMap<Row, { page: PageRows; ids: string[] }>();
	closed = false;
	readonly controller: LiveChatEntriesController;
	readonly rows: readonly object[];
	readonly render: () => void;
	readonly live: ReadonlySet<string>;
	constructor(
		controller: LiveChatEntriesController,
		rows: readonly object[],
		render: () => void,
		live: ReadonlySet<string>,
	) {
		this.controller = controller;
		this.rows = rows;
		this.render = render;
		this.live = live;
	}
}

/** A mounted page holds its exact converted rows. A late read edits only those rows, never replacing a
 * newly published reply or borrowing positions from a different page/session. */
export class TaskChatDecoration {
	private adopted?: Adopted;
	readonly live = new Set<string>();
	clear(): void {
		if (this.adopted) this.adopted.closed = true;
		this.adopted = undefined;
		this.live.clear();
	}
	observe(entry: object): void {
		const adopted = this.adopted;
		const shown = adopted?.shown.get(entry as Row);
		if (!adopted || !shown) return;
		adopted.shown.delete(entry as Row);
		const page = shown.page;
		const idle = !page.anchors.size && !page.orders.size;
		page.runs ??= promptRuns(page.page.entries);
		for (const id of shown.ids) {
			if (!page.asked.anchors.has(id)) page.anchors.add(id);
			page.asked.anchors.add(id);
			const prompt = page.runs.get(id);
			if (prompt !== undefined && !page.asked.orders.has(prompt)) {
				page.asked.orders.add(prompt);
				page.orders.add(prompt);
			}
		}
		if (idle && (page.anchors.size || page.orders.size)) queueMicrotask(() => read(adopted, page));
	}
	/** Rows converted from `page`, which is either the first page after a replace or one shown above the others. */
	capture(
		view: object,
		page: TaskChatPage | undefined,
		controller: LiveChatEntriesController,
		rows: readonly object[],
		render: () => void,
	): ((row: ChatMessageEntry | undefined) => void) | undefined {
		if (!page) return undefined;
		const mount = chatMount(view, page.scope);
		if (!mount) return undefined;
		this.adopted ??= new Adopted(controller, rows, render, this.live);
		const adopted = this.adopted;
		const owned: PageRows = {
			page,
			mount,
			at: new Map(),
			own: new Map(),
			asked: { anchors: new Set(), orders: new Set() },
			anchors: new Set(),
			orders: new Set(),
		};
		adopted.pages.unshift(owned);
		const byMessage = new Map<number, string[]>();
		for (const [id, index] of page.positions) {
			const ids = byMessage.get(index);
			if (ids) ids.push(id);
			else byMessage.set(index, [id]);
		}
		let leading = byMessage.get(-1) ?? [];
		let index = 0;
		let previous: Row | undefined;
		return (row) => {
			const ids = byMessage.get(index++) ?? [];
			if (!row) {
				leading.push(...ids);
				return;
			}
			if (row !== previous) for (const id of ids) owned.own.set(id, row);
			previous = row;
			for (const id of ids) owned.at.set(id, row);
			if (!owned.first) {
				owned.first = row;
				for (const id of leading) owned.at.set(id, null);
				ids.unshift(...leading);
				leading = [];
			}
			if (!ids.length) return;
			const shown = adopted.shown.get(row);
			if (shown) shown.ids.push(...ids);
			else adopted.shown.set(row, { page: owned, ids });
		};
	}
}

/** A shown prompt or notice can depend on a saved order: the prompt a parent-linked notice run leads to. */
function promptRuns(entries: readonly ChatPosition[]): Map<string, string> {
	const runs = new Map<string, string>();
	let run: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		const linked = i > 0 && entry.parentId === entries[i - 1]!.id;
		if (entry.role === "prompt" && linked && run.length) {
			for (const notice of run) runs.set(notice, entry.id);
			runs.set(entry.id, entry.id);
		}
		if (entry.role !== "notice") run = [];
		else if (linked && run.length) run.push(entry.id);
		else run = [entry.id];
	}
	return runs;
}

function read(adopted: Adopted, owned: PageRows): void {
	if (adopted.closed) return;
	const anchors = [...owned.anchors],
		orders = [...owned.orders];
	owned.anchors.clear();
	owned.orders.clear();
	const target = new WeakRef(adopted),
		page = new WeakRef(owned);
	void readMountedAnchors(owned.mount, anchors, orders).then((data) => {
		const current = target.deref(),
			from = page.deref();
		if (data && current && from && !current.closed) apply(current, from, data);
	});
}

function apply(adopted: Adopted, owned: PageRows, data: ChatPageDecorations): void {
	const moves = new Map<Row, Row>();
	if (data.before.size) {
		// The topmost page keeps the off-page start of its run; below it, that start is the page above.
		const entries: ChatPosition[] = [];
		const own = new Map<string, Row>();
		adopted.pages.forEach((page, i) => {
			entries.push(...(i === 0 ? page.page.entries : page.page.entries.slice(page.page.prefix)));
			for (const [id, row] of page.own) own.set(id, row);
		});
		const ordered = inDisplayOrder(entries, data.before);
		for (let i = 0; i < ordered.length; i++) {
			const original = entries[i]!,
				prompt = ordered[i]!;
			if (original === prompt || data.before.get(original.id) !== prompt.id) continue;
			// The run's first shown notice; an anchor on an earlier page that is not shown yet draws no row.
			let notice: Row | undefined;
			for (let j = i; !notice && j < entries.length && entries[j] !== prompt; j++) notice = own.get(entries[j]!.id);
			const to = own.get(prompt.id);
			if (notice && to) moves.set(notice, to);
		}
	}
	const after = new Map<Row | null, Row[]>();
	for (const [id, lines] of data.after) {
		let row = owned.at.get(id);
		if (row === undefined) continue;
		if (row === null && owned.first) {
			// Ahead of the page's first row is after whatever an earlier page put above it since.
			const i = adopted.rows.indexOf(owned.first);
			if (i < 0) continue;
			row = i > 0 ? (adopted.rows[i - 1] as Row) : null;
		}
		const kept = after.get(row) ?? [];
		for (const line of lines) if (!line.id || !adopted.live.has(line.id)) kept.push(taskDisplayLine(line));
		after.set(row, kept);
	}
	if (adopted.controller.decorateRows(moves, after)) adopted.render();
}
