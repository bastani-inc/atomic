import type { SessionEntry, SessionManager } from "../../../core/session-manager.ts";
import { buildSessionTree } from "../../../core/session-manager-history.ts";
import type { SessionTreeOutlineEntry } from "../../../core/storage/session/types.js";
import { getSearchableText } from "./tree-selector-content.ts";
import type { FlatNode, ToolCallInfo } from "./tree-selector-types.ts";

type Archive = ReturnType<SessionManager["captureArchive"]>;
/** `limit` is how much of each text field was read; `cut` says whether any of them was longer. */
type Preview = { entry: SessionEntry; label?: string; call?: [string, ToolCallInfo]; limit: number; cut: boolean };
type Load = { limit: number; controller: AbortController };

// The outline keeps a label's first 128 characters; anything that long may continue in the saved entry.
const LABEL_SNIPPET = 128;

/** Characters read for each text field of a row `columns` wide. Wide, joined and combining characters take more than
 * one code unit per column. Rounded up so a small resize or horizontal shift does not read the screen again. */
export function previewLimit(columns: number): number {
	return 2 ** Math.ceil(Math.log2(Math.max(200, columns * 4)));
}

/** An explicit /tree view owns its outline and only its current screen of previews. All asynchronous
 * work is pinned to one store/session/generation/watermark and loses publication rights on close. */
export class StoredTreeView {
	readonly rows = new Map<string, SessionTreeOutlineEntry>();
	private labels = new Map<string, { seq: number; short: string }>();
	private calls = new Map<string, number>();
	private previews = new Map<string, Preview>();
	private loads = new Map<string, Load>();
	private failures = new Map<string, Error>();
	private reported = new Set<string>();
	private labelReads = new Set<AbortController>();
	private visible = "";
	private query = "";
	private searchedLabels = 0;
	private labelVersion = 0;
	private result?: Set<string>;
	private searchFailure?: Error;
	private searching?: AbortController;
	private archive?: Archive;
	onUpdate?: () => void;
	onError?: (error: Error) => void;
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
	/** False once the view is closed: nothing it started may show or report anything after that. */
	get open(): boolean {
		return this.archive !== undefined;
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
	/** Why a visible row has no preview, if reading it failed. */
	failure(id: string) {
		return this.failures.get(id);
	}
	private async preview(id: string, limit: number, signal: AbortSignal): Promise<Preview | undefined> {
		const archive = this.archive,
			row = this.rows.get(id);
		if (!archive || !row) return;
		let cut = false;
		const clip = () => {
			cut = true;
		};
		const { treePresentation, treeToolCall } = await import("../../../core/storage/session/tree-presentation.js");
		const entry =
			archive.held.get(row.seq) ?? (await treePresentation(archive.bytes(row.seq, signal), limit, undefined, clip));
		const preview: Preview = { entry, limit, cut };
		if (entry.type === "message" && entry.message.role === "toolResult") {
			const callId = entry.message.toolCallId,
				seq = this.calls.get(callId);
			if (seq !== undefined) {
				const source = archive.held.get(seq);
				const block =
					source?.type === "message" && source.message.role === "assistant"
						? source.message.content.findLast((b) => b.type === "toolCall" && b.id === callId)
						: undefined;
				const call =
					block?.type === "toolCall"
						? block
						: source
							? undefined
							: await treeToolCall(archive.bytes(seq, signal), callId, limit, clip);
				if (call) preview.call = [callId, { name: call.name, arguments: call.arguments }];
			}
		}
		const l = this.labels.get(id);
		if (l && l.seq > 0 && l.short.length >= LABEL_SNIPPET && limit > LABEL_SNIPPET) {
			const label =
				archive.held.get(l.seq) ?? (await treePresentation(archive.bytes(l.seq, signal), limit, undefined, clip));
			if (label.type === "label") preview.label = label.label;
		}
		preview.cut = cut;
		return preview;
	}
	/** Keep previews for exactly these rows. A row that stays on screen is not read again unless the screen grew past
	 * text that was cut; a row that leaves it is dropped, and its read abandoned. */
	show(ids: readonly string[], columns: number) {
		if (!this.archive) return;
		const limit = previewLimit(columns);
		const key = JSON.stringify([limit, ids]);
		if (key === this.visible) return;
		this.visible = key;
		const keep = new Set(ids);
		for (const [id, load] of this.loads)
			if (!keep.has(id)) {
				load.controller.abort();
				this.loads.delete(id);
			}
		for (const id of this.previews.keys()) if (!keep.has(id)) this.previews.delete(id);
		for (const id of this.failures.keys()) if (!keep.has(id)) this.failures.delete(id);
		for (const id of ids) {
			const ready = this.previews.get(id);
			if ((ready && (!ready.cut || ready.limit >= limit)) || this.failures.has(id)) continue;
			const load = this.loads.get(id);
			if (load && load.limit >= limit) continue;
			load?.controller.abort();
			this.load(id, limit);
		}
	}
	private load(id: string, limit: number) {
		const load: Load = { limit, controller: new AbortController() };
		const { signal } = load.controller;
		this.loads.set(id, load);
		const settle = () => {
			if (signal.aborted) return false;
			if (this.loads.get(id) === load) this.loads.delete(id);
			return true;
		};
		this.preview(id, limit, signal).then(
			(preview) => {
				if (!settle()) return;
				if (preview) this.previews.set(id, preview);
				this.onUpdate?.();
			},
			(error: unknown) => {
				if (!settle()) return;
				const failure = error instanceof Error ? error : new Error(String(error));
				this.failures.set(id, failure);
				this.report(failure);
				this.onUpdate?.();
			},
		);
	}
	/** Report each distinct failure once per view, not once per row or per scroll. */
	private report(error: Error) {
		if (this.reported.has(error.message)) return;
		this.reported.add(error.message);
		this.onError?.(error);
	}
	/** The whole label of a row, for editing. Rows and search hold at most the outline's snippet or a screen of it. */
	async fullLabel(id: string, signal?: AbortSignal): Promise<string | undefined> {
		const archive = this.archive,
			l = this.labels.get(id);
		if (!archive || !l) return undefined;
		if (l.seq < 0 || l.short.length < LABEL_SNIPPET) return l.short;
		const held = archive.held.get(l.seq);
		if (held) return held.type === "label" ? held.label : undefined;
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		this.labelReads.add(controller);
		try {
			const { treeLabel } = await import("../../../core/storage/session/tree-presentation.js");
			controller.signal.throwIfAborted();
			return await treeLabel(archive.bytes(l.seq, controller.signal));
		} finally {
			signal?.removeEventListener("abort", abort);
			this.labelReads.delete(controller);
		}
	}
	/** Whether a row's label may be longer than the outline's snippet. */
	labelIsSnippet(id: string): boolean {
		const l = this.labels.get(id);
		return l !== undefined && l.seq > 0 && l.short.length >= LABEL_SNIPPET;
	}
	/** Whether the search for this query is still reading, or why it failed. */
	searchState(query: string): "pending" | Error | undefined {
		if (!this.archive || query !== this.query || this.result) return;
		return this.searchFailure ?? (this.searching ? "pending" : undefined);
	}
	matches(query: string, ready: () => void): ReadonlySet<string> | undefined {
		const archive = this.archive;
		if (!archive) return;
		if (query === this.query && this.searchedLabels === this.labelVersion) return this.result;
		this.searching?.abort();
		this.searching = undefined;
		this.query = query;
		this.searchedLabels = this.labelVersion;
		this.result = undefined;
		this.searchFailure = undefined;
		if (!query) return;
		const controller = new AbortController();
		this.searching = controller;
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		const version = this.labelVersion;
		void (async () => {
			const { treePresentation } = await import("../../../core/storage/session/tree-presentation.js");
			const labels = new Map<string, string>();
			for (const [id, l] of this.labels) {
				if (l.seq < 0 || l.short.length < LABEL_SNIPPET) labels.set(id, l.short);
				else {
					const entry =
						archive.held.get(l.seq) ??
						(await treePresentation(archive.bytes(l.seq, controller.signal), 200, words));
					if (entry.type === "label" && entry.label) labels.set(id, entry.label);
				}
			}
			const found = new Set<string>();
			for await (const { items } of archive.pages({ signal: controller.signal }))
				for (const item of items) {
					const entry =
						archive.held.get(item.seq) ??
						("entry" in item
							? item.entry
							: await treePresentation(archive.chunks(item, controller.signal), 200, words));
					const text = getSearchableText({ entry, label: labels.get(entry.id), children: [] }).toLowerCase();
					if (words.every((word) => text.includes(word))) found.add(entry.id);
				}
			if (controller.signal.aborted) return;
			this.searching = undefined;
			// A label saved while this search read the archive: search again with it before showing anything.
			if (version === this.labelVersion) this.result = found;
			ready();
			this.onUpdate?.();
		})().catch((e: Error) => {
			if (controller.signal.aborted) return;
			this.searching = undefined;
			this.searchFailure = e;
			this.report(e);
			this.onUpdate?.();
		});
		return;
	}
	labelChanged(id: string, label: string | undefined) {
		if (!this.archive) return;
		if (label) this.labels.set(id, { short: label, seq: -1 });
		else this.labels.delete(id);
		// The row shows the label just saved, not the archived one it replaced.
		const preview = this.previews.get(id);
		if (preview?.label !== undefined) this.previews.set(id, { ...preview, label: undefined });
		this.labelVersion++;
	}
	dispose() {
		const archive = this.archive;
		if (!archive) return;
		this.archive = undefined;
		this.searching?.abort();
		this.searching = undefined;
		for (const load of this.loads.values()) load.controller.abort();
		for (const read of this.labelReads) read.abort();
		this.loads.clear();
		this.labelReads.clear();
		this.rows.clear();
		this.previews.clear();
		this.failures.clear();
		this.labels.clear();
		this.calls.clear();
		this.result = undefined;
		this.searchFailure = undefined;
		archive.held.clear();
		this.onUpdate = this.onError = undefined;
	}
}
