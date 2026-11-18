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

/** Never join bytes across a retained-output gap as if they were contiguous. */
export function taskOutputText(page: OutputPage): string {
	const segments = [
		...page.chunks.map((chunk) => ({ start: chunk.offsets.start, bytes: Buffer.from(chunk.bytes) })),
		...page.omittedRanges.map((range) => ({
			start: range.start,
			bytes: Buffer.from(`\n[Output omitted: bytes ${range.start}-${range.end}]\n`),
		})),
	].sort((a, b) => (BigInt(a.start) < BigInt(b.start) ? -1 : BigInt(a.start) > BigInt(b.start) ? 1 : 0));
	return Buffer.concat(segments.map((segment) => segment.bytes)).toString("utf8");
}
