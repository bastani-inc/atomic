import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only.
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * Attach an LF-only JSONL reader to a stream.
 *
 * This intentionally does not use Node readline. Readline splits on additional
 * Unicode separators that are valid inside JSON strings and therefore does not
 * implement strict JSONL framing.
 */
export function attachJsonlLineReader(
	stream: Readable,
	onLine: (line: string) => void,
	options: {
		maxLinesPerTurn?: number;
		maxLineChars?: number;
		onOversizedLine?: () => void;
	} = {},
): () => void {
	const decoder = new StringDecoder("utf8");
	const maxLinesPerTurn = options.maxLinesPerTurn ?? Number.POSITIVE_INFINITY;
	const maxLineChars = options.maxLineChars ?? Number.POSITIVE_INFINITY;
	let buffer = "";
	let scheduled: ReturnType<typeof setImmediate> | undefined;
	let discardingOversizedLine = false;
	const emitLine = (line: string) => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	const drain = (): void => {
		scheduled = undefined;
		let emitted = 0;
		while (emitted < maxLinesPerTurn) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				if (buffer.length > maxLineChars) {
					buffer = "";
					discardingOversizedLine = true;
					options.onOversizedLine?.();
				}
				stream.resume();
				return;
			}
			if (newlineIndex <= maxLineChars) emitLine(buffer.slice(0, newlineIndex));
			else options.onOversizedLine?.();
			buffer = buffer.slice(newlineIndex + 1);
			emitted += 1;
		}
		if (buffer.includes("\n")) {
			stream.pause();
			scheduled = setImmediate(drain);
		}
		else stream.resume();
	};
	const onData = (chunk: string | Buffer) => {
		let text = typeof chunk === "string" ? chunk : decoder.write(chunk);
		if (discardingOversizedLine) {
			const newlineIndex = text.indexOf("\n");
			if (newlineIndex === -1) return;
			discardingOversizedLine = false;
			text = text.slice(newlineIndex + 1);
		}
		buffer += text;
		if (!scheduled) drain();
	};
	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length > 0 && buffer.length <= maxLineChars) emitLine(buffer);
		else if (buffer.length > maxLineChars) options.onOversizedLine?.();
		buffer = "";
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		if (scheduled) clearImmediate(scheduled);
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
