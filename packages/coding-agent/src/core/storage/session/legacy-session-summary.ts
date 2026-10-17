import { type FileHandle, open } from "node:fs/promises";
import type { SessionEntry } from "../../session-manager-types.js";
import type { JsonlSessionFile } from "./jsonl-session-store.js";
import {
	applySessionSummaryEntries,
	materializeSessionSummaryMetadata,
	type SessionSummaryState,
	summarizeSession,
} from "./session-summary.js";
import type { SessionSummary } from "./types.js";

/** A session this size or smaller is read whole; a larger one is read from its two ends only. */
const SUMMARY_WINDOW_BYTES = 32 * 1024;

/** How far into a large session to look for its first user message before reading it whole. */
const HEAD_SCAN_LIMIT_BYTES = 256 * 1024;
const HEAD_CHUNK_BYTES = 16 * 1024;
const NEWLINE = 10;

interface Scan {
	state: SessionSummaryState;
	texts: string[];
}

function applyLine(scan: Scan, line: string): void {
	if (!line.trim()) return;
	const { state, texts } = applySessionSummaryEntries(scan.state, [JSON.parse(line) as SessionEntry]);
	scan.state = state;
	for (const { text } of texts) scan.texts.push(text);
}

/** Reads entries up to the first user message; returns the offset after the last line consumed. */
async function scanHead(handle: FileHandle, scan: Scan): Promise<{ end: number; complete: boolean }> {
	const chunk = Buffer.alloc(HEAD_CHUNK_BYTES);
	let pending = Buffer.alloc(0);
	let offset = 0;
	let end = 0;
	let header = true;
	while (offset < HEAD_SCAN_LIMIT_BYTES) {
		const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
		if (bytesRead === 0) {
			if (pending.length > 0) applyLine(scan, pending.toString("utf8"));
			return { end: end + pending.length, complete: true };
		}
		offset += bytesRead;
		pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
		for (let newline = pending.indexOf(NEWLINE); newline !== -1; newline = pending.indexOf(NEWLINE)) {
			const line = pending.subarray(0, newline).toString("utf8");
			pending = pending.subarray(newline + 1);
			end += newline + 1;
			if (header) header = false;
			else applyLine(scan, line);
			if (scan.state.firstMessage) return { end, complete: true };
		}
	}
	return { end, complete: false };
}

/**
 * Reads the last window of the file, from the first whole line in it, never re-reading the head.
 * Returns false when the window skips part of the file and holds no complete message, so the
 * latest message time is unknown and the caller must read the session whole.
 */
async function scanTail(handle: FileHandle, size: number, headEnd: number, scan: Scan): Promise<boolean> {
	const start = Math.max(size - SUMMARY_WINDOW_BYTES, headEnd);
	if (start >= size) return true;
	const skipsMiddle = start > headEnd;
	const bytes = Buffer.alloc(size - start + 1);
	let filled = 0;
	while (filled < bytes.length) {
		const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, start - 1 + filled);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	let from = 1;
	if (bytes[0] !== NEWLINE) {
		const newline = bytes.subarray(0, filled).indexOf(NEWLINE, 1);
		if (newline === -1) return !skipsMiddle;
		from = newline + 1;
	}
	if (skipsMiddle) scan.state = { ...scan.state, latestMessageTime: null };
	for (const line of bytes.subarray(from, filled).toString("utf8").split("\n")) applyLine(scan, line);
	return !skipsMiddle || scan.state.latestMessageTime !== null;
}

/**
 * Summarizes an unconverted legacy session without parsing all of it. A session larger than the
 * window is described by its header, the lines up to its first user message, and the lines in its
 * last window. Names, summaries and search text written in between are not seen, and the message
 * count is a lower bound; opening the session converts it in full. A line in either end that
 * cannot be parsed marks the copy as damaged, as it would for a full read.
 */
export async function summarizeLegacySession(
	file: JsonlSessionFile,
	size: number,
	modifiedMs: number,
): Promise<SessionSummary> {
	if (size <= SUMMARY_WINDOW_BYTES) return summarizeSession(await file.read());
	const scan: Scan = { state: applySessionSummaryEntries(undefined, []).state, texts: [] };
	const handle = await open(file.location, "r");
	try {
		const head = await scanHead(handle, scan);
		if (!head.complete) return summarizeSession(await file.read());
		if (!(await scanTail(handle, size, head.end, scan))) return summarizeSession(await file.read());
	} finally {
		await handle.close();
	}
	const state = { ...scan.state, latestMessageTime: scan.state.latestMessageTime ?? modifiedMs };
	return { ...materializeSessionSummaryMetadata(file.header, state), searchText: scan.texts.join(" ") };
}
