import {
	type CardCall,
	type CardHeader,
	type CardPiece,
	cardFields,
	cardHeader,
	cardPiece,
	cardPieceOf,
} from "./card-message-projection.js";
import { SessionConflictError } from "./errors.js";
import { historyChunks } from "./history-pages.js";
import {
	type ChildDisplayCut,
	type ChildDisplayLaunch,
	type OversizedSessionEntry,
	SESSION_HISTORY_CHUNK_BYTES,
	SESSION_HISTORY_PAGE_ENTRIES,
	type SessionStore,
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
/** Rows up to this size are read together, about this much at a time, and parsed whole; a larger row is streamed. */
const BATCH_BYTES = 1024 * 1024;
/** A row an outline shows the card never displays is read with its neighbours only when it is this small. */
const PASSING_BYTES = 16 * 1024;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A context edit: `content` is its replacement's content when its row was parsed, absent when it is streamed later. */
type Edit = { readonly seq: number; readonly bytes: number; readonly content?: { readonly value: unknown } };
type ResultFields = Record<string, unknown>;
type Row = {
	readonly seq: number;
	readonly bytes: number;
	readonly role: string;
	readonly id: unknown;
	piece?: CardPiece;
	readonly toolCallId?: unknown;
	/** A result's fields when its row was parsed; a streamed result is read again only if a shown call wants it. */
	readonly fields?: ResultFields;
	edit?: Edit;
};
async function projectExpanded(
	store: DisplayReader,
	id: string,
	launch: ChildDisplayLaunch,
	cut: ChildDisplayCut,
	signal?: AbortSignal,
): Promise<ExpandedChildDetails> {
	const at = (seq: number, bytes: number): OversizedSessionEntry => ({
		kind: "oversized",
		sessionId: id,
		epoch: cut.epoch,
		seq,
		bytes,
	});
	// A streamed row's header and then its content are read back to back: the first chunk is read once for both.
	let head: { seq: number; bytes: Uint8Array } | undefined;
	async function* chunks(ref: OversizedSessionEntry): AsyncGenerator<Uint8Array> {
		let offset = 0;
		if (head?.seq === ref.seq) {
			offset = head.bytes.length;
			yield head.bytes;
		}
		if (offset < ref.bytes) yield* historyChunks(store, id, cut.epoch, ref, { signal, offset });
	}
	const headerOf = (ref: OversizedSessionEntry) => {
		head = undefined;
		return cardHeader(
			(async function* () {
				for await (const bytes of historyChunks(store, id, cut.epoch, ref, { signal })) {
					head ??= { seq: ref.seq, bytes };
					yield bytes;
				}
			})(),
		);
	};
	const shown = (type: string | undefined, role: string | undefined, seq: number) =>
		(type === "message" && (role === "user" || role === "assistant" || role === "toolResult")) ||
		(!!cut.model && (type === "context_edit" || (type === "compaction" && seq === cut.boundary)));
	const argsOf = (role: string) => (role === "assistant" ? "all" : undefined);

	// What the card shows of the rows in branch order. Model-context rows wait for the edits and the clear boundary
	// that later rows may hold; the released card showed the rows those left.
	let active = !cut.model || !launch.forked;
	let prompt: Row | undefined, answer: Row | undefined;
	let lines: string[] = [];
	const calls: CardCall[] = [],
		wanted = new Set<string>(),
		results = new Map<string, Row>();
	const show = (row: Row) => {
		if (row.role === "toolResult") {
			// Results count from the first shown row on; one may come before the call that wants it.
			if (active && typeof row.toolCallId === "string") results.set(row.toolCallId, row);
			return;
		}
		if (!active && row.role !== "user") return;
		const p = row.piece!;
		if (!active) {
			if (!p.marker) return;
			active = true;
		}
		if (row.role === "user" && !prompt && p.nonblank) prompt = row;
		else if (row.role === "assistant" && p.nonblank) answer = row;
		lines.push(...p.lines);
		if (lines.length > 12) lines = lines.slice(-12);
		for (const c of p.calls) {
			calls.push(c);
			if (c.id) wanted.add(c.id);
		}
	};
	const held: Row[] = [];
	const edits = new Map<string, Edit | null>();
	let boundary: { backend: unknown } | undefined;
	const take = (row: Row) => (cut.model ? held.push(row) : show(row));

	const parsed = (seq: number, bytes: number, e: unknown) => {
		if (!isRecord(e) || typeof e.type !== "string") return;
		const message = isRecord(e.message) ? e.message : undefined;
		const role = typeof message?.role === "string" ? message.role : undefined;
		if (!shown(e.type, role, seq)) return;
		if (e.type === "message") {
			if (role === "toolResult")
				take({ seq, bytes, role, id: e.id, toolCallId: message!.toolCallId, fields: message! });
			else
				take({
					seq,
					bytes,
					role: role!,
					id: e.id,
					piece: cardPieceOf(message!.content, role!, false, argsOf(role!)),
				});
		} else if (e.type === "context_edit") {
			if (typeof e.targetId === "string")
				edits.set(
					e.targetId,
					e.replacement === null
						? null
						: { seq, bytes, content: { value: isRecord(e.replacement) ? e.replacement.content : undefined } },
				);
		} else
			boundary = {
				backend:
					isRecord(e.details) && typeof e.details.backend === "string"
						? e.details.backend.slice(0, 64)
						: undefined,
			};
	};
	const streamed = async (seq: number, bytes: number, outline?: CardHeader) => {
		const ref = at(seq, bytes);
		const h: CardHeader = outline ?? (await headerOf(ref));
		const role = typeof h.role === "string" ? h.role : undefined;
		if (typeof h.type !== "string" || !shown(h.type, role, seq)) return;
		if (h.type === "message") {
			if (role === "toolResult")
				take({ seq, bytes, role, id: h.id, toolCallId: outline ? (await headerOf(ref)).toolCallId : h.toolCallId });
			else
				take({
					seq,
					bytes,
					role: role!,
					id: h.id,
					piece: await cardPiece(chunks(ref), role!, false, false, argsOf(role!)),
				});
		} else if (h.type === "context_edit") {
			const e = await cardFields(chunks(ref), "edit");
			if (typeof e.targetId === "string") edits.set(e.targetId, e.omit ? null : { seq, bytes });
		} else boundary = { backend: (await cardFields(chunks(ref), "boundary")).backend };
	};
	const batch = async (rows: readonly { seq: number; bytes: number }[]) => {
		if (!rows.length) return;
		if (!store.readRange) {
			for (const { seq, bytes } of rows) await streamed(seq, bytes);
			return;
		}
		const range = await store.readRange(id, rows[0]!.seq, rows.at(-1)!.seq, cut.epoch);
		if (range.epoch !== undefined && range.epoch !== cut.epoch)
			throw new SessionConflictError(id, cut.through, range.lastSeq);
		const sizes = new Map(rows.map((r) => [r.seq, r.bytes]));
		range.entries.forEach((e, i) => {
			const seq = range.seqs?.[i] ?? range.startSeq + i;
			const bytes = sizes.get(seq);
			if (bytes !== undefined) parsed(seq, bytes, e);
		});
		await yieldSessionTurn();
	};

	// One forward pass over the shown branch rows, a page of sizes at a time.
	const segments: (readonly [number, number])[] = cut.earlier.map((seq) => [seq, seq] as const);
	if (cut.from <= cut.leaf) segments.push([cut.from, cut.leaf]);
	for (const [first, last] of segments)
		for (let pivot = first; pivot <= last; ) {
			signal?.throwIfAborted();
			const span = await store.readBranchSpan!(id, {
				leaf: cut.leaf,
				first,
				last,
				pivot,
				backward: false,
				epoch: cut.epoch,
			});
			if (!span) break;
			const hi = Math.min(span.end, span.start + SESSION_HISTORY_PAGE_ENTRIES - 1);
			const sizes = await store.readEntrySizes!(id, span.start, hi);
			if (sizes.epoch !== cut.epoch || sizes.lastSeq < cut.through)
				throw new SessionConflictError(id, cut.through, sizes.lastSeq);
			const outline = await store.readTreeOutline?.(id, span.start, hi, cut.epoch);
			let pending: { seq: number; bytes: number }[] = [],
				pendingBytes = 0;
			for (const { seq, bytes } of sizes.sizes) {
				signal?.throwIfAborted();
				const info = outline?.[seq - span.start];
				const known = info && !("streamed" in info) ? info : undefined;
				const skipped = known !== undefined && !shown(known.type, known.role, seq);
				if (bytes > BATCH_BYTES || (skipped && bytes > PASSING_BYTES) || pendingBytes + bytes > BATCH_BYTES) {
					await batch(pending);
					pending = [];
					pendingBytes = 0;
				}
				if (skipped && bytes > PASSING_BYTES) continue;
				if (bytes > BATCH_BYTES) await streamed(seq, bytes, known);
				else {
					pending.push({ seq, bytes });
					pendingBytes += bytes;
				}
			}
			await batch(pending);
			pivot = hi + 1;
			if (pivot <= last) await yieldSessionTurn();
		}

	if (cut.model) {
		const covered = boundary && boundary.backend !== "summary" ? (cut.covered ?? 0) : 0;
		for (const row of held) {
			if (row.seq <= covered) continue;
			const edit = edits.get(row.id as string);
			if (edit === null) continue;
			if (edit) {
				row.edit = edit;
				if (row.role !== "toolResult")
					row.piece = edit.content
						? cardPieceOf(edit.content.value, row.role, false, argsOf(row.role))
						: await cardPiece(chunks(at(edit.seq, edit.bytes)), row.role, true, false, argsOf(row.role));
			}
			show(row);
		}
		held.length = 0;
	}

	const replacementOf = async (edit: Edit) =>
		edit.content ? edit.content.value : (await cardFields(chunks(at(edit.seq, edit.bytes)), "replacement")).content;
	const values = new Map<string, Omit<ExpandedChildCall, "id" | "name" | "args">>();
	for (const [call, row] of results) {
		if (!wanted.has(call)) continue;
		const r = row.fields ?? (await cardFields(chunks(at(row.seq, row.bytes)), row.edit ? "editedResult" : "result"));
		const replacement = row.edit ? await replacementOf(row.edit) : undefined;
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
	const toolCalls: ExpandedChildCall[] = calls.map((c) => ({
		id: c.id,
		name: c.name,
		args: c.args ?? {},
		...(values.get(c.id) ?? { completed: false }),
	}));
	/** The whole text of the prompt or the answer: only the excerpt of each row was kept while reading. */
	const textOf = async (row: Row) => {
		if (row.edit?.content) return cardPieceOf(row.edit.content.value, row.role, true).text;
		if (row.edit) return (await cardPiece(chunks(at(row.edit.seq, row.edit.bytes)), row.role, true, true)).text;
		if (row.bytes <= BATCH_BYTES && store.readRange) {
			const range = await store.readRange(id, row.seq, row.seq, cut.epoch);
			const e = range.entries[0];
			return cardPieceOf(isRecord(e) && isRecord(e.message) ? e.message.content : undefined, row.role, true).text;
		}
		return (await cardPiece(chunks(at(row.seq, row.bytes)), row.role, false, true)).text;
	};
	signal?.throwIfAborted();
	return {
		...(prompt ? { prompt: await textOf(prompt) } : {}),
		toolCalls,
		...(answer ? { result: (await textOf(answer))?.trim() } : {}),
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
