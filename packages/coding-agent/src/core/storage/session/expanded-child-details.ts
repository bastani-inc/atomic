import { type CardPiece, cardFields, cardPiece } from "./card-message-projection.js";
import { SessionConflictError } from "./errors.js";
import { historyChunks } from "./history-pages.js";
import {
	type ChildDisplayCut,
	type ChildDisplayLaunch,
	type OversizedSessionEntry,
	SESSION_HISTORY_CHUNK_BYTES,
	SESSION_HISTORY_PAGE_ENTRIES,
	type SessionStore,
	type SessionTreeOutlineEntry,
	yieldSessionTurn,
} from "./types.js";

export interface ExpandedChildCall {
	readonly id: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
	readonly resultContent?: readonly {
		readonly type: string;
		readonly text?: string;
		readonly data?: string;
		readonly mimeType?: string;
	}[];
	readonly resultDetails?: unknown;
	readonly resultText?: string;
	readonly isError?: boolean;
	readonly durationMs?: number;
	readonly completed: boolean;
}
export interface ExpandedChildDetails {
	readonly prompt?: string;
	readonly result?: string;
	readonly lines: readonly string[];
	readonly toolCalls: readonly ExpandedChildCall[];
}

/** An operator explicitly expanded this card. Keep what its renderers are passed, but not thinking,
 * hidden notices, discarded answers, unmatched outputs, or the session manager. Reads use one generation. */
export async function readExpandedChildDetails(
	store: SessionStore,
	id: string,
	launch: ChildDisplayLaunch = {},
	options: { signal?: AbortSignal } = {},
): Promise<ExpandedChildDetails> {
	const { signal } = options;
	signal?.throwIfAborted();
	if (!store.readChildDisplayCut || !store.readEntrySizes || !store.readEntryChunk || !store.readBranchSpan) {
		// A snapshot-only adapter cannot serve individual historical records. Make the old adapter's
		// snapshot the backing for this explicit read only; never install it on a live session manager.
		const snap = await store.load(id);
		signal?.throwIfAborted();
		const { foldSessionResume, transcriptBranchSpan } = await import("./session-resume.js");
		const { childDisplayCut } = await import("./card-view.js");
		const index = foldSessionResume(undefined, snap.entries);
		const cut = childDisplayCut(
			index,
			launch,
			typeof launch.launchLeafId === "string"
				? snap.entries.findLastIndex((e) => e.id === launch.launchLeafId) + 1 || undefined
				: undefined,
		);
		let cached: { seq: number; bytes: Uint8Array } | undefined;
		const view: DisplayReader = {
			descriptor: store.descriptor,
			readEntrySizes: async (_id, from, to) => ({
				epoch: index.epoch,
				lastSeq: snap.lastSeq,
				sizes: snap.entries
					.slice(from - 1, to)
					.map((e, i) => ({ seq: from + i, bytes: Buffer.byteLength(JSON.stringify(e)) })),
			}),
			readRange: async (_id, startSeq, end) => ({
				epoch: index.epoch,
				lastSeq: snap.lastSeq,
				startSeq,
				entries: snap.entries.slice(startSeq - 1, end),
			}),
			readTreeOutline: async (_id, from, to) =>
				snap.entries.slice(from - 1, to).map((e, i) => ({
					seq: from + i,
					id: e.id,
					parentId: e.parentId,
					type: e.type,
					timestamp: e.timestamp,
					...(e.type === "message" ? { role: e.message.role } : {}),
				})),
			readEntryChunk: async (ref, off) => {
				if (cached?.seq !== ref.seq)
					cached = { seq: ref.seq, bytes: Buffer.from(JSON.stringify(snap.entries[ref.seq - 1])) };
				return cached.bytes.subarray(off, off + SESSION_HISTORY_CHUNK_BYTES);
			},
			readBranchSpan: async (key, range) => transcriptBranchSpan(key, index, range),
		};
		return projectExpanded(view, id, launch, cut, signal);
	}
	return projectExpanded(store, id, launch, await store.readChildDisplayCut(id, launch), signal);
}
type DisplayReader = Pick<
	SessionStore,
	"descriptor" | "readRange" | "readTreeOutline" | "readEntryChunk" | "readEntrySizes" | "readBranchSpan"
>;
async function projectExpanded(
	store: DisplayReader,
	id: string,
	launch: ChildDisplayLaunch,
	cut: ChildDisplayCut,
	signal?: AbortSignal,
): Promise<ExpandedChildDetails> {
	const chunks = (ref: OversizedSessionEntry) => historyChunks(store, id, cut.epoch, ref, { signal });
	async function* range(start: number, end: number, filter: (type: string, role?: string) => boolean) {
		for (let at = start; at <= end; ) {
			signal?.throwIfAborted();
			const span = await store.readBranchSpan!(id, {
				leaf: cut.leaf,
				first: start,
				last: end,
				pivot: at,
				backward: false,
				epoch: cut.epoch,
			});
			if (!span) return;
			const hi = Math.min(span.end, span.start + SESSION_HISTORY_PAGE_ENTRIES - 1);
			const sizes = await store.readEntrySizes!(id, span.start, hi);
			if (sizes.epoch !== cut.epoch || sizes.lastSeq < cut.through)
				throw new SessionConflictError(id, cut.through, sizes.lastSeq);
			const outline = await store.readTreeOutline?.(id, span.start, hi, cut.epoch);
			for (const { seq, bytes } of sizes.sizes) {
				signal?.throwIfAborted();
				const ref: OversizedSessionEntry = { kind: "oversized", sessionId: id, epoch: cut.epoch, seq, bytes };
				const info = outline?.[seq - span.start];
				if (info && !("streamed" in info) && !filter(info.type, info.role)) continue;
				const h = info && !("streamed" in info) ? info : await cardFields(chunks(ref), "header");
				if (typeof h.type === "string" && filter(h.type, typeof h.role === "string" ? h.role : undefined))
					yield {
						ref,
						h: { type: h.type, role: h.role, id: h.id } as Pick<SessionTreeOutlineEntry, "type" | "role" | "id">,
					};
			}
			at = hi + 1;
			if (at <= end) await yieldSessionTurn();
		}
	}
	async function* rows(filter: (type: string, role?: string) => boolean) {
		for (const seq of cut.earlier) yield* range(seq, seq, filter);
		if (cut.from <= cut.leaf) yield* range(cut.from, cut.leaf, filter);
	}
	const edits = new Map<string, OversizedSessionEntry | null>();
	let covered = 0;
	if (cut.model) {
		for await (const { ref, h } of rows((t) => t === "context_edit" || t === "compaction")) {
			if (h.type === "context_edit") {
				const e = await cardFields(chunks(ref), "edit");
				if (typeof e.targetId === "string") edits.set(e.targetId, e.omit ? null : ref);
			} else if (ref.seq === cut.boundary && (await cardFields(chunks(ref), "boundary")).backend !== "summary")
				covered = cut.covered ?? 0;
		}
	}
	type Selected = { ref: OversizedSessionEntry; edit?: OversizedSessionEntry; role: string };
	const piece = (sel: Selected, full = false, args?: ReadonlySet<number>) =>
		cardPiece(chunks(sel.edit ?? sel.ref), sel.role, !!sel.edit, full, args);
	let prompt: Selected | undefined, answer: Selected | undefined;
	let active = !cut.model || !launch.forked;
	let firstSeq = 0;
	let lines: string[] = [];
	const calls: { sel: Selected; names: CardPiece["calls"] }[] = [],
		wanted = new Set<string>();
	for await (const { ref, h } of rows((t, r) => t === "message" && (r === "user" || r === "assistant"))) {
		if (ref.seq <= covered) continue;
		const edit = edits.get(h.id);
		if (edit === null) continue;
		const s = { ref, edit, role: h.role! };
		if (!active && s.role !== "user") continue;
		const p = await piece(s);
		if (!active) {
			if (!p.marker) continue;
			active = true;
			firstSeq = ref.seq;
		}
		if (s.role === "user" && !prompt && p.nonblank) prompt = s;
		else if (s.role === "assistant" && p.nonblank) answer = s;
		lines.push(...p.lines);
		if (lines.length > 12) lines = lines.slice(-12);
		if (p.calls.length) {
			calls.push({ sel: s, names: p.calls });
			for (const c of p.calls) if (c.id) wanted.add(c.id);
		}
	}
	const results = new Map<string, Selected>();
	if (wanted.size)
		for await (const { ref, h } of rows((t, r) => t === "message" && r === "toolResult")) {
			if (ref.seq < firstSeq || ref.seq <= covered) continue;
			const edit = edits.get(h.id);
			if (edit === null) continue;
			const { toolCallId } = await cardFields(chunks(ref), "header");
			if (typeof toolCallId === "string" && wanted.has(toolCallId))
				results.set(toolCallId, { ref, edit, role: "toolResult" });
		}
	const values = new Map<string, Omit<ExpandedChildCall, "id" | "name" | "args">>();
	for (const [call, sel] of results) {
		const r = await cardFields(chunks(sel.ref), sel.edit ? "editedResult" : "result");
		const replacement = sel.edit ? (await cardFields(chunks(sel.edit), "replacement")).content : undefined;
		const c =
			replacement === undefined
				? r.content
				: typeof replacement === "string"
					? [{ type: "text", text: replacement }]
					: replacement;
		const content = (Array.isArray(c) ? c : []) as NonNullable<ExpandedChildCall["resultContent"]>;
		// Fields in the released card's order, as callers that serialize or compare a card see them.
		values.set(call, {
			resultContent: content,
			...(r.details !== undefined ? { resultDetails: r.details } : {}),
			resultText:
				typeof c === "string"
					? c
					: content.flatMap((b) => (b?.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n"),
			isError: r.isError === true,
			...(typeof r.durationMs === "number" ? { durationMs: r.durationMs } : {}),
			completed: true,
		});
	}
	const toolCalls: ExpandedChildCall[] = [];
	for (const row of calls) {
		const p = await piece(row.sel, false, new Set(row.names.map((c) => c.index)));
		for (const c of p.calls)
			toolCalls.push({ id: c.id, name: c.name, args: c.args ?? {}, ...(values.get(c.id) ?? { completed: false }) });
	}
	signal?.throwIfAborted();
	return {
		...(prompt ? { prompt: (await piece(prompt, true)).text } : {}),
		toolCalls,
		...(answer ? { result: (await piece(answer, true)).text?.trim() } : {}),
		lines,
	};
}

/** Only the launch cursor is needed to choose a child's own rows; don't load the owner's unrelated children or its transcript. */
export async function readSavedChildLaunch(
	store: SessionStore,
	id: string,
	entryId: string,
	childId: string,
	signal?: AbortSignal,
): Promise<ChildDisplayLaunch | undefined> {
	if (!store.findEntrySeq || !store.readEntrySizes || !store.readEntryChunk) {
		const e = (await store.load(id)).entries.find((e) => e.id === entryId);
		if (e?.type === "custom" && e.customType === "subagent-child") {
			const d = e.data as ChildDisplayLaunch & {
				version?: number;
				childId?: string;
				runId?: unknown;
				agent?: unknown;
				cwd?: unknown;
				state?: unknown;
				index?: unknown;
			};
			if (
				d?.version === 1 &&
				d.childId === childId &&
				typeof d.runId === "string" &&
				typeof d.agent === "string" &&
				typeof d.cwd === "string" &&
				typeof d.index === "number" &&
				(d.state === "terminal" || d.state === "running")
			)
				return { launchLeafId: d.launchLeafId, launchLeafSeq: d.launchLeafSeq, forked: d.forked };
			return undefined;
		}
		return undefined;
	}
	const cut = await store.readEntrySizes(id, 1, 0);
	const seq = await store.findEntrySeq(id, entryId);
	if (!seq || seq > cut.lastSeq) return undefined;
	const sized = await store.readEntrySizes(id, seq, seq);
	if (sized.epoch !== cut.epoch || sized.lastSeq < cut.lastSeq)
		throw new SessionConflictError(id, cut.lastSeq, sized.lastSeq);
	const size = sized.sizes[0];
	if (!size) return undefined;
	const r = await cardFields(
		historyChunks(
			store,
			id,
			cut.epoch,
			{ kind: "oversized", sessionId: id, epoch: cut.epoch, seq, bytes: size.bytes },
			{ signal },
		),
		"launch",
	);
	if (
		r.id !== entryId ||
		r.customType !== "subagent-child" ||
		r.type !== "custom" ||
		r.version !== 1 ||
		typeof r.runId !== "string" ||
		typeof r.agent !== "string" ||
		typeof r.cwd !== "string" ||
		typeof r.index !== "number" ||
		(r.state !== "terminal" && r.state !== "running") ||
		r.childId !== childId
	)
		return undefined;
	return {
		...(typeof r.launchLeafId === "string" || r.launchLeafId === null ? { launchLeafId: r.launchLeafId } : {}),
		...(typeof r.launchLeafSeq === "number" ? { launchLeafSeq: r.launchLeafSeq } : {}),
		...(typeof r.forked === "boolean" ? { forked: r.forked } : {}),
	};
}
