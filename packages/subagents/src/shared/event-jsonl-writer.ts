import * as fs from "node:fs";
import * as path from "node:path";
import type { DrainableSource, JsonlWriteStream } from "./jsonl-writer.ts";

interface TelemetryState {
	telemetryBytes: number;
	telemetryTruncated: boolean;
}

interface SharedEventWriter extends TelemetryState {
	stream: JsonlWriteStream;
	sources: Set<DrainableSource>;
	refs: number;
	backpressured: boolean;
	closed: boolean;
	failed: boolean;
	filePath: string;
	key: string;
	closingLines: string[];
	settled: Promise<void>;
	resolveSettled: () => void;
}

const writers = new Map<string, SharedEventWriter>();

interface TelemetryHydration extends TelemetryState {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

const hydrationCache = new Map<string, TelemetryHydration>();
const MAX_HYDRATION_ENTRIES = 512;
const HYDRATION_CHUNK_BYTES = 64 * 1024;
const TRUNCATION_MARKER = '"type":"subagent.child.telemetry_truncated"';
let hydrationScanCount = 0;
let hydrationScannedBytes = 0;

function keyFor(filePath: string): string {
	return path.resolve(filePath);
}

function cacheHydration(key: string, hydration: TelemetryHydration): void {
	hydrationCache.delete(key);
	hydrationCache.set(key, hydration);
	while (hydrationCache.size > MAX_HYDRATION_ENTRIES) {
		const oldest = hydrationCache.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		hydrationCache.delete(oldest);
	}
}

function scanForTruncationMarker(filePath: string): boolean {
	hydrationScanCount += 1;
	const handle = fs.openSync(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(HYDRATION_CHUNK_BYTES);
		let offset = 0;
		let overlap = "";
		while (true) {
			const count = fs.readSync(handle, buffer, 0, buffer.length, offset);
			if (count === 0) return false;
			hydrationScannedBytes += count;
			const text = overlap + buffer.subarray(0, count).toString("utf-8");
			if (text.includes(TRUNCATION_MARKER)) return true;
			overlap = text.slice(-(TRUNCATION_MARKER.length - 1));
			offset += count;
		}
	} finally {
		fs.closeSync(handle);
	}
}

function hydrationFromStat(stat: fs.Stats, state: TelemetryState): TelemetryHydration {
	return { dev: Number(stat.dev), ino: Number(stat.ino), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ...state };
}

function existingTelemetryState(filePath: string, seed?: TelemetryState): TelemetryState {
	const key = keyFor(filePath);
	try {
		const stat = fs.statSync(filePath);
		const telemetryTruncated = Boolean(seed?.telemetryTruncated) || scanForTruncationMarker(filePath);
		const telemetryBytes = Math.max(stat.size, seed?.telemetryBytes ?? 0);
		cacheHydration(key, hydrationFromStat(stat, { telemetryBytes, telemetryTruncated }));
		return { telemetryBytes, telemetryTruncated };
	} catch {
		hydrationCache.delete(key);
		return seed
			? { telemetryBytes: seed.telemetryBytes, telemetryTruncated: seed.telemetryTruncated }
			: { telemetryBytes: 0, telemetryTruncated: false };
	}
}

function cacheSettledWriter(writer: SharedEventWriter): void {
	try {
		const stat = fs.statSync(writer.filePath);
		cacheHydration(writer.key, hydrationFromStat(stat, {
			telemetryBytes: Math.max(stat.size, writer.telemetryBytes),
			telemetryTruncated: writer.telemetryTruncated,
		}));
	} catch { hydrationCache.delete(writer.key); }
}

export function resetEventWriterHydrationCacheForTests(): void {
	hydrationCache.clear();
	hydrationScanCount = 0;
	hydrationScannedBytes = 0;
}

export function eventWriterHydrationCacheSizeForTests(): number {
	return hydrationCache.size;
}

export function eventWriterHydrationScanStatsForTests(): { scans: number; bytes: number } {
	return { scans: hydrationScanCount, bytes: hydrationScannedBytes };
}

function resumeSources(writer: SharedEventWriter): void {
	for (const source of writer.sources) source.resume();
	writer.sources.clear();
	writer.backpressured = false;
}

function settleWriter(writer: SharedEventWriter): void {
	if (!writer.failed) cacheSettledWriter(writer);
	if (writers.get(writer.key) === writer) writers.delete(writer.key);
	resumeSources(writer);
	writer.resolveSettled();
}

function failWriter(writer: SharedEventWriter): void {
	if (writer.failed) return;
	writer.failed = true;
	writer.closed = true;
	settleWriter(writer);
}

function write(writer: SharedEventWriter, chunk: string): void {
	if (writer.closed || writer.failed) return;
	try {
		const accepted = writer.stream.write(chunk);
		if (!accepted && !writer.backpressured) {
			writer.backpressured = true;
			for (const source of writer.sources) source.pause();
			writer.stream.once("drain", () => {
				writer.backpressured = false;
				if (!writer.closed && !writer.failed) for (const source of writer.sources) source.resume();
			});
		}
	} catch {
		failWriter(writer);
	}
}

export interface EventWriterLease {
	reserveTelemetry(bytes: number, maxBytes: number): boolean;
	claimTruncationMarker(): boolean;
	writeLine(line: string): void;
	close(): Promise<void>;
}

type StreamFactory = (filePath: string) => JsonlWriteStream;

function createDeferredLease(
	closingWriter: SharedEventWriter,
	filePath: string,
	source: DrainableSource,
	createWriteStream: StreamFactory,
): EventWriterLease {
	const bufferedLines: string[] = [];
	let inner: EventWriterLease | undefined;
	let closePromise: Promise<void> | undefined;
	const activate = async (): Promise<void> => {
		await closingWriter.settled;
		inner = acquireEventWriterInternal(filePath, source, createWriteStream, closingWriter);
		if (!inner) return;
		for (const line of bufferedLines) inner.writeLine(line);
		bufferedLines.length = 0;
	};
	const activated = activate();
	return {
		reserveTelemetry(bytes, maxBytes) {
			if (inner) return inner.reserveTelemetry(bytes, maxBytes);
			if (closingWriter.telemetryTruncated || closingWriter.telemetryBytes + bytes > maxBytes) return false;
			closingWriter.telemetryBytes += bytes;
			return true;
		},
		claimTruncationMarker() {
			if (inner) return inner.claimTruncationMarker();
			if (closingWriter.telemetryTruncated) return false;
			closingWriter.telemetryTruncated = true;
			return true;
		},
		writeLine(line) {
			if (!line.trim()) return;
			if (inner) inner.writeLine(line);
			else bufferedLines.push(line);
		},
		close() {
			closePromise ??= activated.then(() => inner?.close());
			return closePromise;
		},
	};
}

function createWriter(filePath: string, key: string, createWriteStream: StreamFactory, seed?: TelemetryState): SharedEventWriter | undefined {
	let stream: JsonlWriteStream;
	try {
		stream = createWriteStream(filePath);
	} catch {
		return undefined;
	}
	let resolveSettled = () => {};
	const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
	const writer: SharedEventWriter = {
		stream, sources: new Set(), refs: 0, backpressured: false,
		...existingTelemetryState(filePath, seed),
		closed: false, failed: false, filePath, key, closingLines: [], settled, resolveSettled,
	};
	stream.on?.("error", () => failWriter(writer));
	writers.set(key, writer);
	return writer;
}

function acquireEventWriterInternal(
	filePath: string,
	source: DrainableSource,
	createWriteStream: StreamFactory,
	seed?: TelemetryState,
): EventWriterLease | undefined {
	const key = keyFor(filePath);
	let writer = writers.get(key);
	if (writer?.closed) return createDeferredLease(writer, filePath, source, createWriteStream);
	writer ??= createWriter(filePath, key, createWriteStream, seed);
	if (!writer) return undefined;
	writer.refs += 1;
	writer.sources.add(source);
	if (writer.backpressured) source.pause();
	let closePromise: Promise<void> | undefined;
	return {
		reserveTelemetry(bytes, maxBytes) {
			if (writer!.failed || writer!.telemetryTruncated || writer!.telemetryBytes + bytes > maxBytes) return false;
			writer!.telemetryBytes += bytes;
			return true;
		},
		claimTruncationMarker() {
			if (writer!.failed || writer!.telemetryTruncated) return false;
			writer!.telemetryTruncated = true;
			return true;
		},
		writeLine(line) {
			if (line.trim()) write(writer!, `${line}\n`);
		},
		close() {
			if (closePromise) return closePromise;
			writer!.sources.delete(source);
			writer!.refs -= 1;
			if (writer!.refs > 0 || writer!.failed) return closePromise = Promise.resolve();
			writer!.closed = true;
			try {
				writer!.stream.end(() => {
					if (!writer!.failed) {
						for (const line of writer!.closingLines) {
							try { fs.appendFileSync(writer!.filePath, line); } catch { /* telemetry failure is non-fatal */ }
						}
						settleWriter(writer!);
					}
				});
			} catch {
				failWriter(writer!);
			}
			return closePromise = writer!.settled;
		},
	};
}

export function acquireEventWriter(
	filePath: string,
	source: DrainableSource,
	createWriteStream: StreamFactory = (target) => fs.createWriteStream(target, { flags: "a" }),
): EventWriterLease | undefined {
	return acquireEventWriterInternal(filePath, source, createWriteStream);
}

/** Route lifecycle/control appends through an active child writer to avoid mixed handles. */
export function appendToActiveEventWriter(filePath: string, line: string): boolean {
	const writer = writers.get(keyFor(filePath));
	if (!writer) return false;
	if (writer.closed) writer.closingLines.push(`${line}\n`);
	else write(writer, `${line}\n`);
	return true;
}
