import type { SessionEntry, SessionManager } from "../../../core/session-manager.ts";
import { buildSessionTree } from "../../../core/session-manager-history.ts";
import type { SessionTreeOutlineEntry } from "../../../core/storage/session/types.js";
import { getSearchableText } from "./tree-selector-content.ts";
import type { FlatNode, ToolCallInfo } from "./tree-selector-types.ts";

type Archive = ReturnType<SessionManager["captureArchive"]>;
type Preview = { entry: SessionEntry; label?: string; call?: [string, ToolCallInfo] };

/** An explicit /tree view owns its outline and only its current screen of previews. All asynchronous
 * work is pinned to one store/session/generation/watermark and loses publication rights on close. */
export class StoredTreeView {
	readonly rows = new Map<string, SessionTreeOutlineEntry>();
	private labels = new Map<string, { seq: number; short: string }>();
	private calls = new Map<string, number>();
	private previews = new Map<string, Preview>();
	private visible = "";
	private pending?: AbortController;
	private query = "";
	private result?: Set<string>;
	private searching?: AbortController;
	private closed = false;
	onUpdate?: () => void;
	onError?: (error: Error) => void;
	private readonly archive: Archive;
	private constructor(archive: Archive) {
		this.archive = archive;
	}
	static async open(manager: SessionManager) {
		const archive = manager.captureArchive(),
			view = new StoredTreeView(archive);
		// These non-display entries are internal navigation addresses, not synthetic persisted session data.
		const addresses: SessionEntry[] = [];
		const labels = new Map<string, string>(),
			times = new Map<string, string>();
		for await (const page of archive.outline())
			for (const row of page) {
				if (row.leafMove) continue;
				view.rows.set(row.id, row);
				addresses.push({
					id: row.id,
					parentId: row.parentId,
					timestamp: row.timestamp,
					type: "custom",
					customType: "tree-address",
				});
				if (row.labelTarget !== undefined) {
					if (row.label) {
						view.labels.set(row.labelTarget, { seq: row.seq, short: row.label });
						labels.set(row.labelTarget, row.label);
						times.set(row.labelTarget, row.timestamp);
					} else {
						view.labels.delete(row.labelTarget);
						labels.delete(row.labelTarget);
						times.delete(row.labelTarget);
					}
				}
			}
		return { view, tree: buildSessionTree(addresses, labels, times), leaf: archive.leafId };
	}
	indexCalls(nodes: FlatNode[]) {
		for (const node of nodes) {
			const row = this.rows.get(node.node.entry.id);
			for (const id of row?.callIds ?? []) this.calls.set(id, row!.seq);
		}
	}
	peek(id: string) {
		return this.previews.get(id);
	}
	async preview(id: string, width: number, signal: AbortSignal): Promise<Preview | undefined> {
		const row = this.rows.get(id);
		if (!row) return;
		const limit = Math.max(200, width * 4);
		const { treePresentation, treeToolCall } = await import("../../../core/storage/session/tree-presentation.js");
		const entry =
			this.archive.held.get(row.seq) ?? (await treePresentation(this.archive.bytes(row.seq, signal), limit));
		const preview: Preview = { entry };
		if (entry.type === "message" && entry.message.role === "toolResult") {
			const id = entry.message.toolCallId,
				seq = this.calls.get(id);
			if (seq !== undefined) {
				const source = this.archive.held.get(seq);
				const block =
					source?.type === "message" && source.message.role === "assistant"
						? source.message.content.findLast((b) => b.type === "toolCall" && b.id === id)
						: undefined;
				const call =
					block?.type === "toolCall" ? block : await treeToolCall(this.archive.bytes(seq, signal), id, limit);
				if (call) preview.call = [id, { name: call.name, arguments: call.arguments }];
			}
		}
		const l = this.labels.get(id);
		if (l && l.seq > 0 && l.short.length >= 128 && limit > 128) {
			const label = await treePresentation(this.archive.bytes(l.seq, signal), limit);
			if (label.type === "label") preview.label = label.label;
		}
		return preview;
	}
	show(ids: string[], width: number) {
		if (this.closed) return;
		const key = JSON.stringify([ids, width]);
		if (key === this.visible) return;
		this.visible = key;
		this.pending?.abort();
		const controller = new AbortController();
		this.pending = controller;
		const keep = new Set(ids);
		for (const id of this.previews.keys()) if (!keep.has(id)) this.previews.delete(id);
		void (async () => {
			const rows = await Promise.all(
				ids.map(async (id) => [id, await this.preview(id, width, controller.signal)] as const),
			);
			if (controller.signal.aborted) return;
			for (const [id, p] of rows) if (p) this.previews.set(id, p);
			this.onUpdate?.();
		})().catch((e: Error) => {
			if (!controller.signal.aborted) this.onError?.(e);
		});
	}
	matches(query: string, ready: () => void): ReadonlySet<string> | undefined {
		if (this.closed) return;
		if (query === this.query) return this.result;
		this.searching?.abort();
		const controller = new AbortController();
		this.searching = controller;
		this.query = query;
		this.result = undefined;
		if (!query) return;
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		void (async () => {
			const { treePresentation } = await import("../../../core/storage/session/tree-presentation.js");
			const labels = new Map<string, string>();
			for (const [id, l] of this.labels) {
				if (l.seq < 0 || l.short.length < 128) labels.set(id, l.short);
				else {
					const entry = await treePresentation(this.archive.bytes(l.seq, controller.signal), 200, words);
					if (entry.type === "label" && entry.label) labels.set(id, entry.label);
				}
			}
			const found = new Set<string>();
			for await (const { items } of this.archive.pages({ signal: controller.signal }))
				for (const item of items) {
					const entry =
						this.archive.held.get(item.seq) ??
						("entry" in item
							? item.entry
							: await treePresentation(this.archive.chunks(item, controller.signal), 200, words));
					const text = getSearchableText({ entry, label: labels.get(entry.id), children: [] }).toLowerCase();
					if (words.every((word) => text.includes(word))) found.add(entry.id);
				}
			if (!controller.signal.aborted) {
				this.result = found;
				ready();
				this.onUpdate?.();
			}
		})().catch((e: Error) => {
			if (!controller.signal.aborted) this.onError?.(e);
		});
		return;
	}
	labelChanged(id: string, label: string | undefined) {
		if (label) this.labels.set(id, { short: label, seq: -1 });
		else this.labels.delete(id);
		this.query = "";
		this.result = undefined;
	}
	dispose() {
		this.closed = true;
		this.searching?.abort();
		this.pending?.abort();
		this.rows.clear();
		this.previews.clear();
		this.labels.clear();
		this.calls.clear();
		this.result?.clear();
		this.archive.held.clear();
		this.onUpdate = this.onError = undefined;
	}
}
