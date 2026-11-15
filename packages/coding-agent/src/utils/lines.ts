import type { Readable } from "node:stream";

/**
 * Line splitting for JSONL files and line-delimited process output. A line ends only at "\n", and a "\r" before it is
 * dropped. Unlike `node:readline`, U+2028 and U+2029 stay inside the line: `JSON.stringify` leaves both unescaped, so
 * splitting at them cuts a JSON record in two (#4957). Lines are split as bytes and decoded whole, so a character
 * split between two chunks is decoded intact.
 */
export class LineSplitter {
	private parts: Buffer[] = [];

	/** Takes the next chunk and returns every line it completes. */
	push(chunk: Buffer | string): string[] {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		const lines: string[] = [];
		let start = 0;
		for (let newline = bytes.indexOf(0x0a); newline !== -1; newline = bytes.indexOf(0x0a, start)) {
			this.parts.push(bytes.subarray(start, newline));
			lines.push(this.take());
			start = newline + 1;
		}
		if (start < bytes.length) this.parts.push(bytes.subarray(start));
		return lines;
	}

	/** Returns the last line when the input did not end with a newline. */
	end(): string[] {
		return this.parts.length === 0 ? [] : [this.take()];
	}

	private take(): string {
		const line = Buffer.concat(this.parts);
		this.parts = [];
		return line.toString("utf8", 0, line.at(-1) === 0x0d ? line.length - 1 : line.length);
	}
}

/**
 * Calls `onLine` with each line of `input` as its chunks arrive, and with the last line when it ends without a newline.
 * The returned function detaches the reader; no line is delivered after it.
 */
export function attachLineReader(input: Readable, onLine: (line: string) => void): () => void {
	const splitter = new LineSplitter();
	let attached = true;
	const deliver = (lines: string[]): void => {
		for (const line of lines) {
			if (!attached) return;
			onLine(line);
		}
	};
	const onData = (chunk: Buffer | string): void => deliver(splitter.push(chunk));
	const onEnd = (): void => deliver(splitter.end());
	input.on("data", onData);
	input.on("end", onEnd);
	return () => {
		attached = false;
		input.off("data", onData);
		input.off("end", onEnd);
	};
}

/** The lines of `input`, read as it streams; a final newline does not start another line. */
export async function* readLines(input: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
	const splitter = new LineSplitter();
	for await (const chunk of input) yield* splitter.push(chunk);
	yield* splitter.end();
}
