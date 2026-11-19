import { convertToLlm, VERBATIM_COMPACTION_PREFIX, verbatimRecallHint } from "../../messages.js";
import { buildSessionProjection, getBranchPath } from "../../session-manager-history.ts";
import type { LabelEntry, ModelChangeEntry, SessionEntry } from "../../session-manager-types.ts";
import { branchRanges, isBranchCustomState, latestCompactionOf, type SessionResumeIndex } from "./session-resume.js";
import type { SessionForkWindow, SessionRecordHeader, SessionSnapshot, SessionStoredEntry } from "./types.js";

export interface ForkMetadata {
	readonly seq: number;
	readonly type: string;
	readonly id?: string;
	readonly parentId?: string | null;
	readonly boundary?: { first: string | null; covered?: string };
	readonly customType?: string;
	readonly hash?: string;
	readonly assistantModel?: ModelChangeEntry;
}

export function forkMetadata(seq: number, entry: SessionEntry): ForkMetadata {
	const link = { id: entry.id, parentId: entry.parentId };
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
	labels?: boolean,
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
	let labels = false,
		bindings = false;
	for (let end = index.seq; end > 0 && (next !== null || unindexed); ) {
		const start = Math.max(1, end - 63);
		const page = await metadata(Array.from({ length: end - start + 1 }, (_, i) => start + i));
		for (let i = page.length - 1; i >= 0; i--) {
			const m = page[i]!;
			if (unindexed && m.type === "label") labels = true;
			if (next === null || m.id !== next) continue;
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
		index: { ...index, leafSeq: leaf, jumps: jumps.reverse(), compactions, state },
		extras: { labels, bindings },
	};
}

export function fullForkWindow(snapshot: SessionSnapshot, entryId: string): SessionForkWindow | undefined {
	const path = getBranchPath(entryId, new Map(snapshot.entries.map((entry) => [entry.id, entry])));
	if (!path.length) return undefined;
	return { ...snapshot, entries: path, labels: snapshot.entries.filter((e): e is LabelEntry => e.type === "label") };
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
	extras?: { labels: boolean; bindings: boolean },
): Promise<SessionForkWindow | undefined> {
	if (leafSeq <= 0) return undefined;
	const ranges = branchRanges(index, leafSeq).reverse();
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
		if (bindings || wanted.size) {
			for await (const meta of scan(before, [
				...(bindings ? ["workspace_binding"] : []),
				...(wanted.size ? ["atomic.tool-output"] : []),
			])) {
				if (meta.customType === "workspace_binding" && onEarlierBranch(meta.seq)) keep.add(meta.seq);
				if (meta.hash && wanted.has(meta.hash)) {
					archived = true;
					break;
				}
			}
		}
		if (!archived) {
			// The branch-state index contains tool policies, codemode writes, snapshots and explicit thinking/model changes.
			// Only the effective model is needed; it can also come from a covered assistant response. Don't load that answer.
			const transition = await modelPosition(index, before, metadata);
			const earlier = new Set<number>();
			if (transition !== undefined) earlier.add(transition);
			let at = 0;
			for (const d of index.state.split(".")) {
				at += Number.parseInt(d, 36);
				if (at >= start) break;
				if (onEarlierBranch(at)) earlier.add(at);
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
	if (targets.size) {
		// Labels may have been set or cleared on another branch after launch. A replacement keeps its
		// original place in the map; clearing and later setting the same label gives it a new place.
		for await (const m of scan([[1, index.seq]], [], true)) {
			const label = (await read(m.seq, m.seq))[0]?.entry;
			if (label?.type !== "label" || !targets.has(label.targetId)) continue;
			if (label.label) labels.set(label.targetId, label);
			else labels.delete(label.targetId);
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
	return async function* (ranges, customTypes, labels) {
		for (const [lo, hi] of ranges)
			for (let seq = lo; seq <= hi; seq += 128) {
				const page = await metadata(Array.from({ length: Math.min(128, hi - seq + 1) }, (_, i) => seq + i));
				for (const m of page)
					if (
						(labels && m.type === "label") ||
						(m.type === "custom" && m.customType && customTypes.includes(m.customType))
					)
						yield m;
			}
	};
}
