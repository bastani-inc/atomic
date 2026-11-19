import { StringDecoder } from "node:string_decoder";
import type { OutputPage, TaskKind, TaskResult } from "./contracts.js";

/** Raw command output limits from RFC #2884; session history has separate retention. */
export const COMMAND_LIVE_PREVIEW_BYTES = 1048576;
export const COMMAND_FOREGROUND_SPILL_BYTES = 8388608;
export const COMMAND_DISK_OUTPUT_CAP_BYTES = 5368709120;
export const COMMAND_DETAIL_TAIL_BYTES = 8192;
/** Observation expiry releases the caller, never the command process. */
export const COMMAND_FOREGROUND_BUDGET_MS = 10000;

/** Compare logical output bytes to the disk budget without a 32-bit cast. */
export function commandSpoolExceedsCap(fileBytes: bigint, capBytes = BigInt(COMMAND_DISK_OUTPUT_CAP_BYTES)): boolean {
	return fileBytes > capBytes;
}

/** Native completion means the process exited; nonzero shell exits are UI failures. */
export function taskOutcomeStatus(result: TaskResult, kind?: TaskKind): TaskResult["kind"] {
	return kind === "command" && result.kind === "completed" && result.exitCode !== undefined && result.exitCode !== 0
		? "failed"
		: result.kind;
}

/**
 * Decodes the pages of one task's output, read in order, as one UTF-8 stream: a character split between two pages
 * stays whole. Bytes on the two sides of a retained-output gap are never joined: the text before it ends at the gap.
 */
export class TaskOutputDecoder {
	readonly #decoder = new StringDecoder("utf8");

	/** The text of `page`; a character its end splits waits for the next page to complete it. */
	decode(page: OutputPage): string {
		const segments = [
			...page.chunks.map((chunk) => ({ start: chunk.offsets.start, bytes: chunk.bytes, end: undefined })),
			...page.omittedRanges.map((range) => ({ start: range.start, bytes: undefined, end: range.end })),
		].sort((a, b) => (BigInt(a.start) < BigInt(b.start) ? -1 : BigInt(a.start) > BigInt(b.start) ? 1 : 0));
		let text = "";
		for (const segment of segments)
			text +=
				segment.bytes === undefined
					? `${this.#decoder.end()}\n[Output omitted: bytes ${segment.start}-${segment.end}]\n`
					: this.#decoder.write(segment.bytes);
		return text;
	}

	/** The end of the output: a character it ends inside, as a replacement character, or nothing. */
	end(): string {
		return this.#decoder.end();
	}
}

/** Never join bytes across a retained-output gap as if they were contiguous. */
export function taskOutputText(page: OutputPage): string {
	const decoder = new TaskOutputDecoder();
	return decoder.decode(page) + decoder.end();
}

/**
 * The text of `page` where a view shows only its first page of output: a character the page's end splits is left out
 * when more output follows, rather than shown broken.
 */
export function taskOutputHeadText(page: OutputPage): string {
	const decoder = new TaskOutputDecoder();
	return decoder.decode(page) + (page.nextOffset === undefined ? decoder.end() : "");
}
