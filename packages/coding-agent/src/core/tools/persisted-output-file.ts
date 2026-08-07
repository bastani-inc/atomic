/**
 * Bounded writer for persisted tool-output files.
 *
 * Every temp file a tool spills to disk goes through here so no single file can
 * exceed {@link MAX_PERSISTED_OUTPUT_BYTES}. Once the cap is reached the writer
 * stops consuming input and appends {@link PERSISTED_OUTPUT_TRUNCATION_MARKER},
 * so the file stays readable and its size stays bounded even when the producing
 * command never stops.
 */

import { Buffer } from "node:buffer";
import { createWriteStream, type WriteStream } from "node:fs";
import { SESSION_TEMP_FILE_MODE } from "./session-temp-dir.ts";
import { MAX_PERSISTED_OUTPUT_BYTES, PERSISTED_OUTPUT_TRUNCATION_MARKER } from "./tool-limits.js";

/** Trim a buffer to at most `maxBytes` without splitting a UTF-8 sequence. */
export function truncateBufferAtUtf8Boundary(buffer: Buffer, maxBytes: number): Buffer {
	if (buffer.length <= maxBytes) {
		return buffer;
	}
	let end = maxBytes;
	// Walk back over continuation bytes (10xxxxxx) to the start of the character
	// that would otherwise be cut in half.
	while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
		end--;
	}
	return buffer.subarray(0, end);
}

/**
 * Cap an in-memory string destined for a persisted-output file.
 *
 * Returns the input unchanged when it already fits; otherwise the returned text
 * is the leading portion plus {@link PERSISTED_OUTPUT_TRUNCATION_MARKER}, and the
 * whole result stays within `maxBytes`.
 */
export function capPersistedText(text: string, maxBytes: number = MAX_PERSISTED_OUTPUT_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) {
		return text;
	}
	const markerBytes = Buffer.byteLength(PERSISTED_OUTPUT_TRUNCATION_MARKER, "utf8");
	const budget = Math.max(0, maxBytes - markerBytes);
	const head = truncateBufferAtUtf8Boundary(Buffer.from(text, "utf8"), budget).toString("utf8");
	return `${head}${PERSISTED_OUTPUT_TRUNCATION_MARKER}`;
}

export interface PersistedOutputFileOptions {
	/** Byte cap for this file. Defaults to {@link MAX_PERSISTED_OUTPUT_BYTES}. */
	maxBytes?: number;
}

/**
 * A write stream that refuses to grow past its byte cap.
 *
 * Marker space cannot simply be subtracted up front: input that lands *exactly*
 * on the cap is not truncated and must be preserved whole. So the writer keeps a
 * short trailing buffer — everything past `maxBytes - markerBytes` — unwritten
 * until it knows which case it is in. Input that stays within the cap has that
 * tail flushed on close; input that exceeds it gets the UTF-8-safe prefix plus
 * the marker, and the file lands at the cap. Flushes are cut at character
 * boundaries, so the file never ends mid-character.
 *
 * Mirrors the subset of `WriteStream` the spill-file call sites use: `write`, a
 * fire-and-forget `end`, and an awaitable `close`. A stream error is captured by
 * a listener installed at construction, so a spill file that fails to write can
 * never surface as an uncaught exception on the fire-and-forget path.
 */
export class PersistedOutputFile {
	readonly path: string;
	private stream: WriteStream | undefined;
	private readonly maxBytes: number;
	/** Bytes that may be written before the marker's reserved space is needed. */
	private readonly safeLimit: number;
	private writtenBytes = 0;
	private pending: Buffer = Buffer.alloc(0);
	private capReached = false;
	private failure: Error | undefined;

	constructor(path: string, options: PersistedOutputFileOptions = {}) {
		this.path = path;
		this.maxBytes = options.maxBytes ?? MAX_PERSISTED_OUTPUT_BYTES;
		const markerBytes = Buffer.byteLength(PERSISTED_OUTPUT_TRUNCATION_MARKER, "utf8");
		this.safeLimit = Math.max(0, this.maxBytes - markerBytes);
		const stream = createWriteStream(path, { mode: SESSION_TEMP_FILE_MODE });
		stream.on("error", (error: Error) => {
			this.failure ??= error;
		});
		this.stream = stream;
	}

	/** Whether the cap was reached and the marker written. */
	get truncated(): boolean {
		return this.capReached;
	}

	/** The write error this file failed with, if any. */
	get error(): Error | undefined {
		return this.failure;
	}

	/** Total input bytes accepted so far, including the unflushed tail. */
	private get acceptedBytes(): number {
		return this.writtenBytes + this.pending.length;
	}

	write(chunk: Buffer | string): void {
		const stream = this.stream;
		if (!stream || this.capReached) {
			return;
		}
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
		if (buffer.length === 0) {
			return;
		}
		this.pending = this.pending.length === 0 ? buffer : Buffer.concat([this.pending, buffer]);

		if (this.acceptedBytes > this.maxBytes) {
			// Past the cap for certain: emit the safe prefix and the marker, then
			// stop consuming input.
			this.flushUpTo(stream, this.safeLimit - this.writtenBytes);
			this.pending = Buffer.alloc(0);
			this.capReached = true;
			stream.write(PERSISTED_OUTPUT_TRUNCATION_MARKER);
			return;
		}
		// Still within the cap: write everything except the marker-sized tail,
		// which is only decidable once the input ends.
		this.flushUpTo(stream, this.safeLimit - this.writtenBytes);
	}

	/** Write at most `room` pending bytes, cut at a UTF-8 character boundary. */
	private flushUpTo(stream: WriteStream, room: number): void {
		if (room <= 0 || this.pending.length === 0) {
			return;
		}
		const head = this.pending.length <= room ? this.pending : truncateBufferAtUtf8Boundary(this.pending, room);
		if (head.length === 0) {
			return;
		}
		this.writtenBytes += head.length;
		this.pending = this.pending.subarray(head.length);
		stream.write(head);
	}

	/** Release the trailing buffer once the input is known to fit within the cap. */
	private flushRemainder(stream: WriteStream): void {
		if (this.capReached || this.pending.length === 0) {
			return;
		}
		const tail = this.pending;
		this.pending = Buffer.alloc(0);
		this.writtenBytes += tail.length;
		stream.write(tail);
	}

	/** Close without waiting for the flush to complete. */
	end(): void {
		const stream = this.stream;
		if (!stream) {
			return;
		}
		this.stream = undefined;
		this.flushRemainder(stream);
		stream.end();
	}

	/** Close and wait for the flush, rejecting on a write error. */
	async close(): Promise<void> {
		const stream = this.stream;
		if (!stream) {
			if (this.failure) {
				throw this.failure;
			}
			return;
		}
		this.stream = undefined;
		this.flushRemainder(stream);
		if (this.failure) {
			// The stream already failed and will not emit `finish`; do not wait for it.
			stream.destroy();
			throw this.failure;
		}
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				stream.off("finish", onFinish);
				reject(error);
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});
	}
}
