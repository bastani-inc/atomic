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
import { closeSync, createWriteStream, fchmodSync, fstatSync, openSync, type WriteStream } from "node:fs";
import { SESSION_TEMP_FILE_MODE } from "./session-temp-dir.ts";
import { MAX_PERSISTED_OUTPUT_BYTES, PERSISTED_OUTPUT_TRUNCATION_MARKER } from "./tool-limits.js";

/**
 * Create a persisted-output file and prove it is owner-only before use.
 *
 * `wx` refuses to reuse anything already at the path, so a foreign file is never
 * truncated or adopted; `fchmod` on the descriptor then removes whatever the
 * umask took away, and the re-stat confirms it. Any failure throws, and every
 * caller turns that into "no spill file, no advertised path".
 */
function openFileWithEnforcedMode(path: string): number {
	const fd = openSync(path, "wx", SESSION_TEMP_FILE_MODE);
	if (process.platform === "win32") {
		return fd;
	}
	try {
		fchmodSync(fd, SESSION_TEMP_FILE_MODE);
		const stat = fstatSync(fd);
		if ((stat.mode & 0o777) !== SESSION_TEMP_FILE_MODE) {
			throw new Error(`persisted output file ${path} could not be restricted to 0600`);
		}
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		if (typeof uid === "number" && stat.uid !== uid) {
			throw new Error(`persisted output file ${path} is owned by another account`);
		}
	} catch (error) {
		closeSync(fd);
		throw error;
	}
	return fd;
}

/** Whether `byte` is a UTF-8 continuation byte (`10xxxxxx`). */
function isUtf8Continuation(byte: number): boolean {
	return byte >= 0x80 && byte <= 0xbf;
}

/** Expected sequence length for a valid UTF-8 lead; zero for ASCII or an invalid lead. */
function utf8SequenceLength(byte: number): number {
	if (byte >= 0xc2 && byte <= 0xdf) return 2;
	if (byte >= 0xe0 && byte <= 0xef) return 3;
	if (byte >= 0xf0 && byte <= 0xf4) return 4;
	return 0;
}

/**
 * Validate a continuation byte, including UTF-8's strict second-byte ranges.
 *
 * Those ranges reject overlong encodings (`E0`, `F0`), UTF-16 surrogates
 * (`ED`), and code points above U+10FFFF (`F4`).
 */
function isValidUtf8SequenceByte(buffer: Buffer, leadIndex: number, index: number): boolean {
	const byte = buffer[index]!;
	if (!isUtf8Continuation(byte)) return false;
	if (index !== leadIndex + 1) return true;

	const lead = buffer[leadIndex]!;
	if (lead === 0xe0) return byte >= 0xa0;
	if (lead === 0xed) return byte <= 0x9f;
	if (lead === 0xf0) return byte >= 0x90;
	if (lead === 0xf4) return byte <= 0x8f;
	return true;
}

/**
 * Return `end` unless its prefix ends inside a valid UTF-8 sequence.
 *
 * At most three bytes before the cut can belong to an incomplete sequence. A
 * run of raw continuation bytes, an invalid lead (`C0`, `C1`, `F5`-`F7`), or a
 * sequence with an invalid continuation is binary data and stays untouched.
 */
function utf8SafePrefixLength(buffer: Buffer, end: number): number {
	const cut = Math.max(0, Math.min(end, buffer.length));
	if (cut === 0) return 0;

	let leadIndex = cut - 1;
	let continuationCount = 0;
	while (leadIndex >= 0 && continuationCount < 3 && isUtf8Continuation(buffer[leadIndex]!)) {
		leadIndex--;
		continuationCount++;
	}
	if (leadIndex < 0) return cut;

	const sequenceLength = utf8SequenceLength(buffer[leadIndex]!);
	if (sequenceLength === 0 || cut - leadIndex >= sequenceLength) return cut;

	const availableEnd = Math.min(buffer.length, leadIndex + sequenceLength);
	for (let index = leadIndex + 1; index < availableEnd; index++) {
		if (!isValidUtf8SequenceByte(buffer, leadIndex, index)) return cut;
	}
	return leadIndex;
}

/** Trim a buffer to at most `maxBytes` without splitting a valid UTF-8 sequence. */
export function truncateBufferAtUtf8Boundary(buffer: Buffer, maxBytes: number): Buffer {
	if (buffer.length <= maxBytes) return buffer;
	return buffer.subarray(0, utf8SafePrefixLength(buffer, maxBytes));
}

/**
 * Length of the longest prefix of `buffer` that does not end mid-character.
 * Invalid UTF-8 remains complete raw binary; only a valid partial tail waits.
 */
export function completeUtf8PrefixLength(buffer: Buffer): number {
	return utf8SafePrefixLength(buffer, buffer.length);
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
		// Own the descriptor so the mode can be enforced before a single byte is
		// written and before the path is handed to anyone: `mode` on open is only a
		// request, which the process umask then narrows — a umask of 0o077 is
		// harmless, but 0o777 leaves the file at 000 and the advertised path
		// unreadable. Enforcing after close would be too late to fail closed.
		const fd = openFileWithEnforcedMode(path);
		const stream = createWriteStream(path, { fd, autoClose: true });
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

	/**
	 * Write at most `room` pending bytes, never ending mid-character.
	 *
	 * Both cuts matter. Cutting at `room` uses the boundary walk; flushing the
	 * whole buffer still holds back an incomplete trailing sequence, because its
	 * continuation bytes arrive in the *next* chunk — and if the cap intervenes
	 * first, a lead byte already on disk would sit orphaned before the marker.
	 */
	private flushUpTo(stream: WriteStream, room: number): void {
		if (room <= 0 || this.pending.length === 0) {
			return;
		}
		const head =
			this.pending.length <= room
				? this.pending.subarray(0, completeUtf8PrefixLength(this.pending))
				: truncateBufferAtUtf8Boundary(this.pending, room);
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
