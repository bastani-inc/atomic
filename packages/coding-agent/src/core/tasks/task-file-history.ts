import { createHash } from "node:crypto";
import { type FileHandle, open, stat } from "node:fs/promises";
import type { SessionEntry } from "../session-manager-types.ts";
import { EntryTypeReader, JsonTextChecker } from "../storage/session/entry-type.js";
import {
	SESSION_HISTORY_PAGE_BYTES as BUDGET,
	SESSION_HISTORY_CHUNK_BYTES as CHUNK,
	SESSION_HISTORY_PAGE_ENTRIES as LIMIT,
} from "../storage/session/types.js";

/** A task's file cursor uses byte positions. They are not session store sequence numbers. */
export interface FileTaskPage {
	items: (
		| { seq: number; entry: SessionEntry }
		| { seq: number; bytes: number; detail?: { role: string; inheritedEnd: boolean } }
	)[];
	adjacent: { current: string; older?: string; newer?: string };
	nextCursor?: string;
	file: true;
}
type Span = { start: number; end: number; next: number };
type FileCut = {
	source: string;
	inode: string;
	size: number;
	stamp: string;
	witness: string;
	at: number;
	backward: boolean;
	after: number;
	anchor?: string;
	side?: "before" | "after";
};
function digest(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("base64url");
}
function encode(cut: FileCut): string {
	return Buffer.from(JSON.stringify(cut)).toString("base64url");
}
function decode(value: string, source: string): FileCut {
	if (value.length > 1536) throw new Error("Invalid saved file cursor");
	const c = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as FileCut;
	if (
		!c ||
		c.source !== source ||
		typeof c.backward !== "boolean" ||
		!Number.isSafeInteger(c.at) ||
		c.at < 0 ||
		!Number.isSafeInteger(c.size) ||
		c.at > c.size ||
		!Number.isSafeInteger(c.after) ||
		c.after < 0 ||
		typeof c.stamp !== "string" ||
		typeof c.inode !== "string" ||
		typeof c.witness !== "string"
	)
		throw new Error("Transcript cursor belongs to another task or session");
	return c;
}
class Lines {
	private readonly file: FileHandle;
	private readonly size: number;
	private start = -1;
	private block: Buffer = Buffer.alloc(0);
	constructor(file: FileHandle, size: number) {
		this.file = file;
		this.size = size;
	}
	private async at(pos: number): Promise<Buffer> {
		const start = Math.floor(pos / CHUNK) * CHUNK;
		if (start !== this.start) {
			this.block = Buffer.allocUnsafe(Math.min(CHUNK, this.size - start));
			let length = 0;
			while (length < this.block.length) {
				const got = await this.file.read(this.block, length, this.block.length - length, start + length);
				if (!got.bytesRead) throw new Error("Session file changed while it was being read");
				length += got.bytesRead;
			}
			this.start = start;
		}
		return this.block;
	}
	async forward(pos: number, limit: number): Promise<Span> {
		const start = pos;
		while (pos < limit) {
			const block = await this.at(pos),
				end = block.indexOf(10, pos - this.start);
			if (end >= 0 && this.start + end < limit) return { start, end: this.start + end, next: this.start + end + 1 };
			pos = this.start + block.length;
		}
		return { start, end: limit, next: limit };
	}
	async backward(pos: number, min: number): Promise<Span> {
		const next = pos;
		if (pos > min && (await this.at(pos - 1))[pos - 1 - this.start] === 10) pos--;
		const end = pos;
		while (pos > min) {
			const block = await this.at(pos - 1),
				found = block.lastIndexOf(10, pos - 1 - this.start);
			if (found >= 0 && this.start + found >= min) return { start: this.start + found + 1, end, next };
			pos = this.start;
		}
		return { start: min, end, next };
	}
	async *chunks(from: number, to: number): AsyncGenerator<Buffer, void> {
		while (from < to) {
			const b = await this.at(from),
				count = Math.min(to - from, b.length - (from - this.start));
			yield b.subarray(from - this.start, from - this.start + count);
			from += count;
		}
	}
	async bytes(from: number, to: number): Promise<Buffer> {
		const parts: Buffer[] = [];
		for await (const part of this.chunks(from, to)) parts.push(part);
		return parts.length === 1 ? parts[0]! : Buffer.concat(parts, to - from);
	}
}
async function matchesHeader(lines: Lines, header: Span, sessionId: string): Promise<boolean> {
	if (header.end <= BUDGET) {
		const h = JSON.parse((await lines.bytes(0, header.end)).toString("utf8")) as { id?: string; type?: string };
		return h.type === "session" && h.id === sessionId;
	}
	const type = new EntryTypeReader(["session"]);
	for await (const b of lines.chunks(0, header.end)) if (type.feed(b)) break;
	if (type.finish() !== "session") return false;
	const { chunkedEntryHasId } = await import("../storage/session/chunked-resume-projection.js");
	return chunkedEntryHasId(lines.chunks(0, header.end), sessionId);
}
/** On replacement prefer the actual saved entry, even when preceding entries changed length. Scan only on
 * replacement; ordinarily each next/previous request seeks straight to its byte boundary. */
async function rebind(lines: Lines, headerEnd: number, size: number, cut: FileCut): Promise<number> {
	let at = size,
		remaining = cut.after,
		fallback = remaining === 0 ? size : headerEnd;
	while (at > headerEnd) {
		const span = await lines.backward(at, headerEnd);
		at = span.start;
		if (--remaining === 0) fallback = at;
		if (!cut.anchor && remaining <= 0) break;
		if (cut.anchor && span.end - span.start <= BUDGET) {
			try {
				const e = JSON.parse((await lines.bytes(span.start, span.end)).toString("utf8")) as SessionEntry;
				if (typeof e.id === "string" && digest(e.id) === cut.anchor)
					return cut.side === "after" ? span.next : span.start;
			} catch {
				/* A torn final line is not a recorded entry. */
			}
		}
	}
	return fallback;
}
async function filePage(
	path: string,
	id: string,
	cursor?: string,
	signal?: AbortSignal,
	initialBackward = true,
	detail?: { throughId?: string },
): Promise<FileTaskPage> {
	const source = digest(JSON.stringify([path, id]));
	const cut = cursor === undefined ? undefined : decode(cursor, source);
	const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT")
			throw new Error(`History unavailable: the session file was moved or deleted (${path}).`);
		throw error;
	});
	// A detail can be left during its first read; release the old OS handle without waiting for another UI turn.
	const closeOnAbort = () => {
		void file.close().catch(() => {});
	};
	signal?.addEventListener("abort", closeOnAbort, { once: true });
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			signal?.throwIfAborted();
			const stat = await file.stat({ bigint: true });
			const size = Number(stat.size),
				inode = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`,
				stamp = `${stat.mtimeNs}:${stat.ctimeNs}`;
			const lines = new Lines(file, size),
				header = await lines.forward(0, size);
			if (!(await matchesHeader(lines, header, id)))
				throw new Error(`History unavailable: its session file now belongs to another session (${path}).`);
			let limit = size,
				at = initialBackward ? size : header.next;
			if (cut) {
				const same =
					cut.inode === inode &&
					((size === cut.size && stamp === cut.stamp) ||
						(size > cut.size && digest(await lines.bytes(Math.max(0, cut.size - 64), cut.size)) === cut.witness));
				if (same) {
					limit = cut.size;
					at = cut.at;
				} else at = await rebind(lines, header.next, size, cut);
			}
			const backward = cut?.backward ?? initialBackward;
			const base = {
				source,
				inode,
				stamp,
				size: limit,
				witness: digest(await lines.bytes(Math.max(0, limit - 64), limit)),
			};
			let after = cut?.after ?? 0,
				used = 0;
			const items: FileTaskPage["items"] = [];
			let low = at,
				high = at,
				lowAfter = after,
				highAfter = after;
			for (let visited = 0; visited < LIMIT && (backward ? at > header.next : at < limit); visited++) {
				signal?.throwIfAborted();
				const span = backward ? await lines.backward(at, header.next) : await lines.forward(at, limit);
				const bytes = span.end - span.start;
				if (items.length && bytes > BUDGET - used) break;
				let item: FileTaskPage["items"][number] | undefined;
				if (bytes > BUDGET) {
					if (span.next === size && span.end === size) {
						const checker = new JsonTextChecker();
						for await (const b of lines.chunks(span.start, span.end)) checker.feed(b);
						if (checker.finish()) item = { seq: span.start, bytes };
					} else item = { seq: span.start, bytes };
				} else {
					const raw = (await lines.bytes(span.start, span.end)).toString("utf8");
					if (raw.trim()) {
						try {
							item = { seq: span.start, entry: JSON.parse(raw) as SessionEntry };
						} catch (error) {
							if (span.next !== size) throw error;
						}
					}
				}
				if (backward) {
					low = at = span.start;
					lowAfter = ++after;
				} else {
					high = at = span.next;
					highAfter = --after;
				}
				if (item) {
					if (detail && !("entry" in item)) {
						const { chunkedTaskDetailFields } = await import("../storage/session/chunked-resume-projection.js");
						item.detail = await chunkedTaskDetailFields(
							() => lines.chunks(span.start, span.end),
							detail.throughId,
						);
					}
					items.push(item);
					used += bytes;
				}
			}
			if (backward) items.reverse();
			const top = items[0],
				bottom = items.at(-1);
			const position = (
				at: number,
				after: number,
				backward: boolean,
				item: FileTaskPage["items"][number] | undefined,
				side: "before" | "after",
			) =>
				encode({
					...base,
					at,
					after: Math.max(0, after),
					backward,
					...(item && "entry" in item && typeof item.entry.id === "string"
						? { anchor: digest(item.entry.id), side }
						: {}),
				});
			const older = low > header.next ? position(low, lowAfter, true, top, "before") : undefined,
				newer = high < limit ? position(high, highAfter, false, bottom, "after") : undefined;
			const current = backward
				? position(high, highAfter, true, bottom, "after")
				: position(low, lowAfter, false, top, "before");
			const end = await file.stat({ bigint: true });
			if (end.size !== stat.size || end.mtimeNs !== stat.mtimeNs || end.ctimeNs !== stat.ctimeNs) continue;
			return { file: true, items, adjacent: { current, older, newer }, nextCursor: backward ? older : newer };
		}
		throw new Error(`History unavailable: the session file changed while it was being read (${path}).`);
	} finally {
		signal?.removeEventListener("abort", closeOnAbort);
		await file.close();
	}
}
export async function* taskFilePages(
	path: string,
	sessionId: string,
	options: {
		cursor?: string;
		signal?: AbortSignal;
		direction?: "forward" | "backward";
		detail?: { throughId?: string };
	},
): AsyncGenerator<FileTaskPage, void> {
	let cursor = options.cursor;
	for (;;) {
		options.signal?.throwIfAborted();
		const page = await filePage(
			path,
			sessionId,
			cursor,
			options.signal,
			options.direction !== "forward",
			options.detail,
		);
		yield page;
		if (!page.nextCursor) return;
		cursor = page.nextCursor;
	}
}

/**
 * The bytes of one saved line too large for a page, `bytes` long at byte `offset`, from the file generation the page
 * that returned it read: `cursor` is that page's `adjacent.current`. The file must still be that session's, unchanged
 * or only appended to, before the first read and after the last; the caller never sees bytes of another generation.
 */
export async function* taskFileEntryChunks(
	path: string,
	sessionId: string,
	cursor: string,
	offset: number,
	bytes: number,
	signal?: AbortSignal,
): AsyncGenerator<Uint8Array, void> {
	const cut = decode(cursor, digest(JSON.stringify([path, sessionId])));
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(bytes) ||
		offset < 0 ||
		bytes < 0 ||
		offset + bytes > cut.size
	)
		throw new RangeError("Invalid saved file entry range");
	signal?.throwIfAborted();
	const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT")
			throw new Error(`History unavailable: the session file was moved or deleted (${path}).`);
		throw error;
	});
	const closeOnAbort = () => {
		void file.close().catch(() => {});
	};
	signal?.addEventListener("abort", closeOnAbort, { once: true });
	const verify = async () => {
		signal?.throwIfAborted();
		const stat = await file.stat({ bigint: true });
		const size = Number(stat.size);
		const lines = new Lines(file, size);
		const same =
			`${stat.dev}:${stat.ino}:${stat.birthtimeNs}` === cut.inode &&
			((size === cut.size && `${stat.mtimeNs}:${stat.ctimeNs}` === cut.stamp) ||
				(size > cut.size && digest(await lines.bytes(Math.max(0, cut.size - 64), cut.size)) === cut.witness)) &&
			(await matchesHeader(lines, await lines.forward(0, size), sessionId));
		signal?.throwIfAborted();
		if (!same) throw new Error(`History unavailable: the session file changed while it was being read (${path}).`);
	};
	let started = false;
	let verified = false;
	try {
		await verify();
		started = true;
		const end = offset + bytes;
		let at = offset;
		for await (const part of new Lines(file, end).chunks(offset, end)) {
			signal?.throwIfAborted();
			at += part.length;
			// Check the generation again once the last byte is read, before the caller sees it.
			if (at >= end) {
				await verify();
				verified = true;
			}
			yield part;
		}
		verified = true;
	} finally {
		try {
			// A reader that stopped early, once it had its fields, still only used bytes of this generation.
			if (started && !verified && !signal?.aborted) await verify();
		} finally {
			signal?.removeEventListener("abort", closeOnAbort);
			await file.close().catch(() => {});
		}
	}
}

/** Why a task's saved file could not be read, worded as its runner words a failed whole read. */
export async function taskFileUnavailable(path: string, error: unknown): Promise<string> {
	const message = error instanceof Error ? error.message : String(error);
	if (message.startsWith("History unavailable:")) return message;
	const exists = await stat(path).then(
		() => true,
		() => false,
	);
	if (!exists) return `History unavailable: the session file was moved or deleted (${path}).`;
	return `History unavailable: ${error instanceof Error ? error.message : String(error ?? "its session could not be read")}`;
}

/** A detail card needs the first prompt and last response, not the intervening conversation. */
export async function taskFileDetail(
	path: string,
	id: string,
	throughId: string | undefined,
	text: (message: Extract<SessionEntry, { type: "message" }>["message"]) => string | undefined,
	signal?: AbortSignal,
): Promise<{ prompt?: string; output?: string }> {
	const stamp = async () => {
		const s = await stat(path, { bigint: true });
		return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		signal?.throwIfAborted();
		const observed = await stamp();
		let prompt: string | undefined, output: string | undefined;
		for (const direction of ["forward", "backward"] as const) {
			const forward = direction === "forward";
			let own = !throughId || !forward;
			read: for await (const page of taskFilePages(path, id, { direction, signal, detail: { throughId } })) {
				for (const item of forward ? page.items : [...page.items].reverse()) {
					if (throughId && ("entry" in item ? item.entry.id === throughId : item.detail?.inheritedEnd)) {
						if (!forward) break read;
						own = true;
						continue;
					}
					if (!own) continue;
					const role =
						"entry" in item
							? item.entry.type === "message"
								? item.entry.message.role
								: undefined
							: item.detail?.role;
					if (role !== (forward ? "user" : "assistant")) continue;
					const value =
						"entry" in item
							? item.entry.type === "message"
								? text(item.entry.message)
								: undefined
							: `Saved file entry at byte ${item.seq} is ${item.bytes} bytes. Open its session history or export the session for the original bytes.`;
					if (forward) prompt = value;
					else output = value;
					break read;
				}
			}
		}
		if ((await stamp()) === observed)
			return { ...(prompt === undefined ? {} : { prompt }), ...(output === undefined ? {} : { output }) };
	}
	throw new Error(`History unavailable: the session file changed while it was being read (${path}).`);
}
