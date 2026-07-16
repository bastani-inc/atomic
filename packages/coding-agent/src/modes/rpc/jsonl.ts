import type { Readable } from "node:stream";

/** Serialize one LF-delimited JSON record. */
export function serializeJsonLine(value: object | boolean | null | number | string): string {
	return `${JSON.stringify(value)}\n`;
}

export interface JsonlReaderOptions {
	maxBytesPerTurn?: number;
	maxFrameBytes?: number;
	/** @deprecated Use maxFrameBytes. Retained for source compatibility; measured as UTF-8 bytes. */
	maxLineChars?: number;
	maxLinesPerTurn?: number;
	onOversizedLine?: () => void;
}

/**
 * Attach a strict LF-only, UTF-8 byte-bounded JSONL reader.
 *
 * The stream is paused before queued chunks are drained, so one turn cannot parse
 * an unbounded number of frames. Oversized records are discarded through their LF;
 * the next bounded record remains readable.
 */
export function attachJsonlLineReader(
	stream: Readable,
	onLine: (line: string) => void,
	options: JsonlReaderOptions = {},
): () => void {
	const maxFrameBytes = options.maxFrameBytes ?? options.maxLineChars ?? Number.POSITIVE_INFINITY;
	const maxBytesPerTurn = options.maxBytesPerTurn ?? Number.POSITIVE_INFINITY;
	const maxLinesPerTurn = options.maxLinesPerTurn ?? Number.POSITIVE_INFINITY;
	const chunks: Buffer[] = [];
	let frameParts: Buffer[] = [];
	let frameBytes = 0;
	let discarding = false;
	let scheduled: ReturnType<typeof setImmediate> | undefined;
	let ended = false;
	let detached = false;

	const finishFrame = (): void => {
		if (discarding) {
			discarding = false;
			frameParts = [];
			frameBytes = 0;
			return;
		}
		const frame = Buffer.concat(frameParts, frameBytes);
		frameParts = [];
		frameBytes = 0;
		const withoutCr = frame.at(-1) === 0x0d ? frame.subarray(0, -1) : frame;
		onLine(withoutCr.toString("utf8"));
	};

	const consume = (chunk: Buffer, byteBudget: number, lineBudget: number): { offset: number; lines: number } => {
		let offset = 0;
		let lines = 0;
		while (offset < chunk.length && offset < byteBudget && lines < lineBudget) {
			const budgetEnd = Math.min(chunk.length, offset + (byteBudget - offset));
			const newline = chunk.indexOf(0x0a, offset);
			const end = newline !== -1 && newline < budgetEnd ? newline : budgetEnd;
			const part = chunk.subarray(offset, end);
			if (!discarding && frameBytes + part.length <= maxFrameBytes) {
				if (part.length > 0) frameParts.push(part);
				frameBytes += part.length;
			} else if (!discarding) {
				discarding = true;
				frameParts = [];
				frameBytes = 0;
				options.onOversizedLine?.();
			}
			offset = end;
			if (newline === end) {
				offset += 1;
				finishFrame();
				lines += 1;
			}
			if (end === budgetEnd && newline !== end) break;
		}
		return { offset, lines };
	};

	const schedule = (): void => {
		if (!scheduled && !detached) scheduled = setImmediate(drain);
	};
	const drain = (): void => {
		scheduled = undefined;
		let bytes = 0;
		let lines = 0;
		while (chunks.length > 0 && bytes < maxBytesPerTurn && lines < maxLinesPerTurn) {
			const chunk = chunks[0]!;
			const result = consume(chunk, maxBytesPerTurn - bytes, maxLinesPerTurn - lines);
			bytes += result.offset;
			lines += result.lines;
			if (result.offset === chunk.length) chunks.shift();
			else {
				chunks[0] = chunk.subarray(result.offset);
				break;
			}
		}
		if (chunks.length > 0) schedule();
		else if (ended) {
			if (!discarding && frameBytes > 0) finishFrame();
			frameParts = [];
			frameBytes = 0;
		} else stream.resume();
	};
	const onData = (chunk: string | Buffer): void => {
		stream.pause();
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		schedule();
	};
	const onEnd = (): void => {
		ended = true;
		if (scheduled) {
			clearImmediate(scheduled);
			scheduled = undefined;
			drain();
		} else if (chunks.length === 0 && !discarding && frameBytes > 0) finishFrame();
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		detached = true;
		if (scheduled) clearImmediate(scheduled);
		stream.off("data", onData);
		stream.off("end", onEnd);
		chunks.length = 0;
	};
}
