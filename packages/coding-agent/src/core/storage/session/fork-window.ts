import { convertToLlm, VERBATIM_COMPACTION_PREFIX, verbatimRecallHint } from "../../messages.ts";
import { buildSessionProjection, getBranchPath } from "../../session-manager-history.ts";
import type { LabelEntry, ModelChangeEntry, SessionEntry } from "../../session-manager-types.ts";
import {
	type LegacyCompletionTarget,
	legacyCompletionTarget,
	resolvesCompletionHeader,
} from "../../tasks/reopened-completion.js";
import {
	branchRanges,
	completionIdOf,
	intentForAcknowledgement,
	isBranchCustomState,
	latestCompactionOf,
	type SessionResumeIndex,
} from "./session-resume.js";
import type { SessionForkWindow, SessionRecordHeader, SessionSnapshot, SessionStoredEntry } from "./types.js";

export interface ForkMetadata {
	readonly seq: number;
	readonly type: string;
	readonly id?: string;
	readonly parentId?: string | null;
	readonly boundary?: { first: string | null; covered?: string };
	readonly customType?: string;
	readonly hash?: string;
	readonly completionId?: string;
	readonly assistantModel?: ModelChangeEntry;
	readonly label?: LabelEntry;
	readonly labelTarget?: string;
	readonly labelSet?: boolean;
}

export function forkMetadata(seq: number, entry: SessionEntry): ForkMetadata {
	const link = { id: entry.id, parentId: entry.parentId };
	if (entry.type === "label") return { seq, type: entry.type, ...link, label: entry };
	if (
		entry.type === "compaction" &&
		(entry.details as { strategy?: string } | undefined)?.strategy === "verbatim-lines"
	)
		return {
			seq,
			type: entry.type,
			...link,
			boundary: { first: entry.firstKeptEntryId, covered: entry.coveredThroughEntryId },
		};
	if (entry.type === "custom") {
		const hash = (entry.data as { hash?: string } | undefined)?.hash;
		return {
			seq,
			type: entry.type,
			...link,
			customType: entry.customType,
			...(entry.customType === "task-completion-intent" || entry.customType === "task-completion-ack"
				? { completionId: completionIdOf(entry) }
				: {}),
			...(entry.customType === "atomic.tool-output" && typeof hash === "string" ? { hash } : {}),
		};
	}
	if (entry.type === "message" && entry.message.role === "assistant")
		return {
			seq,
			type: entry.type,
			...link,
			assistantModel: {
				type: "model_change",
				id: entry.id,
				parentId: entry.parentId,
				timestamp: entry.timestamp,
				provider: entry.message.provider,
				modelId: entry.message.model,
			},
		};
	return { seq, type: entry.type, ...link };
}

type Range = readonly [number, number];
type ReadRows = (start: number, end: number) => Promise<readonly SessionStoredEntry[]>;
export type ReadMetadata = (seqs: readonly number[]) => Promise<ForkMetadata[]>;
/** Locate records not covered by the branch-state index without loading old conversation payloads. */
export type ScanForkRecords = (
	ranges: readonly Range[],
	customTypes: readonly string[],
	entryTypes?: readonly string[],
) => AsyncIterable<ForkMetadata>;

function namedOutputs(entries: readonly SessionStoredEntry[], sessionId: string): Set<string> {
	const names = new Set<string>();
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			for (const match of value.matchAll(/tool-output:\/\/([0-9a-f]{64})(?![\w/])/gu)) names.add(match[1]!);
		} else if (value && typeof value === "object") for (const part of Object.values(value)) visit(part);
	};
	const path = entries.map((row) => row.entry);
	for (const m of convertToLlm(buildSessionProjection(path, path.at(-1)?.id, undefined, sessionId, path).messages))
		visit(m.content);
	for (const { entry } of entries)
		if (entry.type === "custom" && entry.customType === "atomic.tool-output")
			names.delete((entry.data as { hash?: string } | undefined)?.hash ?? "");
	return names;
}

/** A transition key in older indexes joins provider and model with '/'. If either contained '/', another
 * pair could have had the same key. Resolve the last actual model-setting row, reading metadata only. */
async function modelPosition(index: SessionResumeIndex, before: readonly Range[], metadata: ReadMetadata) {
	const last = index.models.findLast(([seq]) => before.some(([lo, hi]) => seq >= lo && seq <= hi));
	if (!index.needsBranchRebuild && (!last || last[1].indexOf("/") === last[1].lastIndexOf("/"))) return last?.[0];
	const earliest = index.needsBranchRebuild ? 1 : last![0];
	for (let r = before.length - 1; r >= 0; r--) {
		const [from, to] = before[r]!;
		for (let end = to; end >= Math.max(from, earliest); ) {
			const start = Math.max(from, earliest, end - 127);
			const found = (await metadata(Array.from({ length: end - start + 1 }, (_, i) => start + i))).findLast(
				(m) => m.type === "model_change" || m.assistantModel,
			);
			if (found) return found.seq;
			end = start - 1;
		}
	}
	return last?.[0];
}

/** A memory session or a concurrent database writer may not have rebuilt its branch index yet. Walk the
 * captured watermark backwards once. When no index exists, also recover the setting positions on that path. */
export async function locateFork(
	index: SessionResumeIndex,
	entryId: string,
	metadata: ReadMetadata,
	unindexed = false,
	pageSize = 64,
) {
	if (!index.needsBranchRebuild && index.lastId === entryId) return { index, leaf: index.seq };
	let leaf = 0,
		previous = 0,
		next: string | null = entryId;
	let point: ForkMetadata | undefined,
		first = -1,
		covered = -1;
	const jumps: Array<readonly [number, number, number]> = [];
	const states: number[] = [];
	const waitingAcks = new Map<string, number>(),
		acks: Array<readonly [number, number]> = [];
	let labels = false,
		bindings = false;
	let nameSeq: number | undefined, summarySeq: number | null | undefined;
	for (let end = index.seq; end > 0 && (next !== null || unindexed); ) {
		const start = Math.max(1, end - pageSize + 1);
		const page = await metadata(Array.from({ length: end - start + 1 }, (_, i) => start + i));
		for (let i = page.length - 1; i >= 0; i--) {
			const m = page[i]!;
			if (unindexed && m.type === "label") labels = true;
			const ancestor = next !== null && m.id === next;
			// Reconstruct only links for acknowledgements on the selected window. An intervening sibling
			// intent or acknowledgement consumes the association; it never becomes the child's evidence.
			if (unindexed && m.completionId !== undefined) {
				if (m.customType === "task-completion-ack") {
					const inWindow =
						!point ||
						(point.boundary?.first
							? first < 0
							: point.boundary?.covered !== undefined && covered < 0 && point.boundary.covered !== m.id);
					if (ancestor && inWindow) waitingAcks.set(m.completionId, m.seq);
					else waitingAcks.delete(m.completionId);
				} else if (m.customType === "task-completion-intent") {
					const ack = waitingAcks.get(m.completionId);
					if (ancestor && ack !== undefined) acks.push([m.seq, ack]);
					waitingAcks.delete(m.completionId);
				}
			}
			if (!ancestor) continue;
			if (nameSeq === undefined && m.type === "session_info") nameSeq = m.seq;
			if (summarySeq === undefined && (m.type === "session_summary" || m.type === "branch_summary"))
				summarySeq = m.type === "branch_summary" ? null : m.seq;
			if (unindexed) {
				if (m.type === "custom" && m.customType === "workspace_binding") bindings = true;
				if (
					m.type === "thinking_level_change" ||
					m.type === "model_change" ||
					m.type === "worktree_snapshot" ||
					(m.type === "custom" && isBranchCustomState(m.customType))
				)
					states.push(m.seq);
			}
			if (!leaf) {
				leaf = m.seq;
				if (!index.needsBranchRebuild) return { index, leaf };
			}
			if (previous && m.seq !== previous - 1) jumps.push([previous, previous, m.seq]);
			if (m.id === point?.boundary?.first) first = m.seq;
			if (m.id === point?.boundary?.covered) covered = m.seq;
			if (m.boundary && !point) point = m;
			previous = m.seq;
			next = m.parentId ?? null;
		}
		end = start - 1;
	}
	if (previous > 1) jumps.push([previous, previous, 0]);
	const compactions: SessionResumeIndex["compactions"] = point ? [[point.seq, first, covered]] : [];
	states.reverse();
	const state = unindexed ? states.map((seq, i) => (seq - (states[i - 1] ?? 0)).toString(36)).join(".") : index.state;
	return {
		leaf,
		index: {
			...index,
			leafSeq: leaf,
			jumps: jumps.reverse(),
			compactions,
			state,
			acks: unindexed ? acks.sort((a, b) => a[1] - b[1]) : index.acks,
			nameSeq,
			summarySeq: summarySeq ?? undefined,
		},
		extras: { labels, bindings, branchCatalog: true },
	};
}

export function fullForkWindow(snapshot: SessionSnapshot, entryId: string): SessionForkWindow | undefined {
	const path = getBranchPath(entryId, new Map(snapshot.entries.map((entry) => [entry.id, entry])));
	if (!path.length) return undefined;
	return { ...snapshot, entries: path, labels: snapshot.entries.filter((e): e is LabelEntry => e.type === "label") };
}

/** The retained acknowledgement makes this one older row inert on both live and tail reopens. */
async function earlierStopEvidence(
	index: SessionResumeIndex,
	rows: readonly SessionStoredEntry[],
	before: (seq: number) => boolean,
	readMany: (seqs: readonly number[]) => Promise<readonly SessionStoredEntry[]>,
): Promise<SessionStoredEntry[]> {
	if (!index.acks.length) return [];
	const cards = new Map<string, Array<{ entry: SessionEntry; target: LegacyCompletionTarget }>>();
	for (const { entry } of rows) {
		const target = legacyCompletionTarget(entry);
		if (!target) continue;
		const group = cards.get(target.id) ?? [];
		group.push({ entry, target });
		cards.set(target.id, group);
	}
	if (!cards.size) return [];
	const candidates = new Map<string, number | null>();
	for (const { entry, seq } of rows) {
		const id = completionIdOf(entry);
		if (!id || !cards.has(id) || entry.type !== "custom") continue;
		if (entry.customType === "task-completion-intent") {
			cards.delete(id);
			candidates.delete(id);
		} else if (entry.customType === "task-completion-ack") {
			const intent = intentForAcknowledgement(index, seq);
			if (intent !== undefined && before(intent))
				candidates.set(id, candidates.has(id) && candidates.get(id) !== intent ? null : intent);
		}
	}
	const seqs = [...candidates.values()].filter((seq): seq is number => seq !== null);
	if (!seqs.length) return [];
	return (await readMany(seqs)).filter(({ entry, seq }) => {
		const id = completionIdOf(entry);
		return (
			entry.type === "custom" &&
			entry.customType === "task-completion-intent" &&
			!!id &&
			candidates.get(id) === seq &&
			cards.get(id)?.some((c) => resolvesCompletionHeader(c.entry, c.target, entry.data)) === true
		);
	});
}

/** Read from a single store snapshot. The index supplies ancestry even when an older branch was selected. */
export async function indexedForkWindow(
	header: SessionRecordHeader,
	index: SessionResumeIndex,
	leafSeq: number,
	read: ReadRows,
	readMany: (seqs: readonly number[]) => Promise<readonly SessionStoredEntry[]>,
	metadata: ReadMetadata,
	scan: ScanForkRecords,
	extras?: { labels: boolean; bindings: boolean; branchCatalog?: boolean },
	orderedLabels?: () => Promise<readonly number[]>,
): Promise<SessionForkWindow | undefined> {
	if (leafSeq <= 0) return undefined;
	const ranges: Range[] = [];
	for (const [lo, hi] of branchRanges(index, leafSeq).reverse()) {
		const last = ranges.at(-1);
		if (last && last[1] + 1 === lo) ranges[ranges.length - 1] = [last[0], hi];
		else ranges.push([lo, hi]);
	}
	const compact = latestCompactionOf(index, leafSeq);
	const rows: SessionStoredEntry[] = [];
	const takeRanges = async (intervals: readonly Range[]) => {
		for (const [lo, hi] of intervals) if (lo <= hi) for (const row of await read(lo, hi)) rows.push(row);
	};
	let archived = false;
	if (compact) {
		const start = compact.retainedStartSeq;
		const before: Range[] = [];
		for (const [lo, hi] of ranges) if (lo < start) before.push([lo, Math.min(hi, start - 1)]);
		await takeRanges(ranges.map(([lo, hi]) => [Math.max(lo, start), hi]));
		const boundary = rows.find((row) => row.seq === compact.seq)?.entry;
		const covered = compact.coveredThroughSeq;
		const anchor: SessionStoredEntry | undefined =
			covered !== undefined &&
			covered < start &&
			boundary?.type === "compaction" &&
			boundary.coveredThroughEntryId !== undefined
				? {
						seq: covered,
						entry: {
							type: "custom",
							customType: "atomic.fork-anchor",
							id: boundary.coveredThroughEntryId,
							parentId: null,
							timestamp: boundary.timestamp,
						},
					}
				: undefined;
		if (anchor) rows.unshift(anchor);
		const onEarlierBranch = (seq: number) => before.some(([lo, hi]) => seq >= lo && seq <= hi);
		const wanted = namedOutputs(rows, header.id);
		const bindings =
			extras?.bindings || Object.keys(index.latest).some((key) => key.startsWith("workspace_binding:"));
		const keep = new Set<number>();
		// These catalog values are usually already indexed. A later name, summary or retirement on a
		// different branch is not authoritative for this child: resolve the last record on its path.
		const catalogTypes: string[] = [];
		if (index.nameSeq && !rows.some(({ entry }) => entry.type === "session_info")) {
			if (onEarlierBranch(index.nameSeq)) keep.add(index.nameSeq);
			else if (!extras?.branchCatalog) catalogTypes.push("session_info");
		}
		if (!rows.some(({ entry }) => entry.type === "session_summary" || entry.type === "branch_summary")) {
			if (index.summarySeq && onEarlierBranch(index.summarySeq)) keep.add(index.summarySeq);
			else if (!extras?.branchCatalog && (index.summarySeq || index.jumps.length || leafSeq !== index.leafSeq))
				catalogTypes.push("session_summary", "branch_summary");
		}
		let nameSeq: number | undefined, summarySeq: number | undefined;
		if (bindings || wanted.size || catalogTypes.length) {
			for await (const meta of scan(
				before,
				[...(bindings ? ["workspace_binding"] : []), ...(wanted.size ? ["atomic.tool-output"] : [])],
				catalogTypes,
			)) {
				if (meta.type === "session_info") nameSeq = meta.seq;
				else if (meta.type === "session_summary") summarySeq = meta.seq;
				else if (meta.type === "branch_summary") summarySeq = undefined;
				if (meta.customType === "workspace_binding" && onEarlierBranch(meta.seq)) keep.add(meta.seq);
				if (meta.hash && wanted.has(meta.hash)) {
					archived = true;
					break;
				}
			}
		}
		if (!archived) {
			for (const row of await earlierStopEvidence(index, rows, onEarlierBranch, readMany)) rows.push(row);
			if (nameSeq) keep.add(nameSeq);
			if (summarySeq) keep.add(summarySeq);
			// The branch-state index contains tool policies, codemode writes, snapshots and explicit thinking/model changes.
			// Only the effective model is needed; it can also come from a covered assistant response. Don't load that answer.
			const transition = await modelPosition(index, before, metadata);
			const earlier = new Set<number>();
			if (transition !== undefined) earlier.add(transition);
			// The resume index tracks older settings and plain snapshots separately from protocol state.
			for (const positions of [index.state, index.settingsHistory, index.snapshotRefs]) {
				if (!positions) continue;
				let at = 0;
				for (const d of positions.split(".")) {
					at += Number.parseInt(d, 36);
					if (at >= start) break;
					if (onEarlierBranch(at)) earlier.add(at);
				}
			}
			let thinking = 0;
			const candidates = [...earlier].sort((a, b) => a - b);
			for (let i = 0; i < candidates.length; i += 256)
				for (const m of await metadata(candidates.slice(i, i + 256))) {
					if (m.seq === transition && m.assistantModel) rows.push({ seq: m.seq, entry: m.assistantModel });
					else if (
						m.type === "model_change"
							? m.seq === transition
							: m.type === "worktree_snapshot" || m.type === "custom"
					)
						keep.add(m.seq);
					else if (m.type === "thinking_level_change") thinking = m.seq;
				}
			if (thinking) keep.add(thinking);
			// Use the original setting at the cut when it was retained anyway; otherwise only its ID is needed.
			if (anchor && (keep.has(anchor.seq) || rows.some((row) => row !== anchor && row.seq === anchor.seq)))
				rows.splice(rows.indexOf(anchor), 1);
			for (const row of await readMany([...keep].sort((a, b) => a - b))) rows.push(row);
			rows.sort((a, b) => a.seq - b.seq);
		}
	}
	if (!compact || archived) {
		rows.length = 0;
		await takeRanges(ranges);
	}
	let parentId: string | null = null;
	const entries = rows.map(({ entry, seq }) => {
		if (!compact || archived) return entry;
		let linked = entry.parentId === parentId ? entry : { ...entry, parentId };
		parentId = entry.id;
		// Older clients also understand a complete boundary message. Freeze its original history URL before copying it.
		if (linked.type === "compaction" && seq === compact.seq) {
			const details = linked.details as { form?: string; backend?: string } | undefined;
			if (details && !("form" in details) && details.backend !== "summary")
				linked = {
					...linked,
					summary: VERBATIM_COMPACTION_PREFIX + verbatimRecallHint(header.id) + linked.summary,
					details: { ...details, form: "compacted" },
				};
		}
		return linked;
	});
	const labels = new Map<string, LabelEntry>();
	const targets = new Set(entries.filter((e) => extras?.labels || index.latest[`label:${e.id}`]).map((e) => e.id));
	if (targets.size && orderedLabels && rows.length < index.seq) {
		const wanted = new Set([...targets].map((id) => index.latest[`label:${id}`]?.[0]));
		const seqs = (await orderedLabels()).filter((seq) => wanted.has(seq));
		const known = new Map(rows.filter((r) => r.entry.type === "label").map((r) => [r.seq, r.entry]));
		for (const row of await readMany(seqs.filter((seq) => !known.has(seq)))) known.set(row.seq, row.entry);
		for (const seq of seqs) {
			const e = known.get(seq);
			if (e?.type === "label" && e.label && targets.has(e.targetId)) labels.set(e.targetId, e);
		}
	} else if (targets.size) {
		// Labels may have been set or cleared on another branch after launch. A replacement keeps its
		// original place in the map; clearing and later setting the same label gives it a new place.
		const active = new Map<string, ForkMetadata>();
		const apply = (m: ForkMetadata) => {
			const target = m.label?.targetId ?? m.labelTarget;
			if (target === undefined || !targets.has(target)) return;
			if (m.label?.label || m.labelSet) active.set(target, m);
			else active.delete(target);
		};
		if (rows.length === index.seq) {
			for (const row of rows)
				if (row.entry.type === "label") apply({ seq: row.seq, type: "label", label: row.entry });
		} else for await (const m of scan([[1, index.seq]], [], ["label"])) apply(m);
		// Inline labels arrive in the scan itself; only selected, still-active large labels need a batched payload read.
		const missing = await readMany([...active.values()].filter((m) => !m.label).map((m) => m.seq));
		const large = new Map(missing.map((row) => [row.seq, row.entry]));
		for (const [target, m] of active) {
			const entry = m.label ?? large.get(m.seq);
			if (entry?.type === "label") labels.set(target, entry);
		}
	}
	return { header, entries, labels: [...labels.values()], lastSeq: index.seq, epoch: index.epoch };
}

const PAGE_BYTES = 16 * 1024;
/** Read small candidates directly; never assemble a large retired entry just to identify its kind or model. */
export async function byteMetadata(
	seq: number,
	size: number,
	read: (offset: number, length: number) => Promise<Uint8Array>,
): Promise<ForkMetadata> {
	if (size <= PAGE_BYTES)
		return forkMetadata(seq, JSON.parse(new TextDecoder().decode(await read(0, size))) as SessionEntry);
	const { projectForkMetadata } = await import("./chunked-resume-projection.js");
	return projectForkMetadata(
		seq,
		(async function* () {
			for (let offset = 0; offset < size; offset += PAGE_BYTES)
				yield await read(offset, Math.min(PAGE_BYTES, size - offset));
		})(),
	);
}

/** Batch nearby small file entries without allocating the span of a large entry between them. */
export function rangedForkMetadata(
	span: (seq: number) => readonly [number, number],
	read: (offset: number, length: number) => Promise<Uint8Array>,
): ReadMetadata {
	return async (seqs) => {
		const page: ForkMetadata[] = [];
		for (let i = 0; i < seqs.length; ) {
			const seq = seqs[i]!;
			const [start, end] = span(seq);
			if (end - start > PAGE_BYTES) {
				page.push(await byteMetadata(seq, end - start, (offset, n) => read(start + offset, n)));
				i++;
				continue;
			}
			let j = i + 1,
				last = end;
			while (j < seqs.length) {
				const [next, stop] = span(seqs[j]!);
				if (next < last || stop - start > PAGE_BYTES) break;
				last = stop;
				j++;
			}
			const bytes = await read(start, last - start);
			for (; i < j; i++) {
				const at = seqs[i]!;
				const [lo, hi] = span(at);
				page.push(
					forkMetadata(
						at,
						JSON.parse(new TextDecoder().decode(bytes.subarray(lo - start, hi - start))) as SessionEntry,
					),
				);
			}
		}
		return page;
	};
}

export function scanForkRecords(metadata: ReadMetadata): ScanForkRecords {
	return async function* (ranges, customTypes, entryTypes = []) {
		for (const [lo, hi] of ranges)
			for (let seq = lo; seq <= hi; seq += 128) {
				const page = await metadata(Array.from({ length: Math.min(128, hi - seq + 1) }, (_, i) => seq + i));
				for (const m of page)
					if (
						entryTypes.includes(m.type) ||
						(m.type === "custom" && m.customType && customTypes.includes(m.customType))
					)
						yield m;
			}
	};
}
