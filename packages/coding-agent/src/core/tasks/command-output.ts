import { isUtf8 } from "node:buffer";
import type { OutputPage, OutputRange, TaskResult } from "./contracts.js";
import type { TaskLease, TaskSupervisor } from "./supervisor.js";

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
export function taskOutcomeStatus(result: TaskResult, kind?: "agent" | "command"): TaskResult["kind"] {
	return kind === "command" && result.kind === "completed" && result.exitCode !== undefined && result.exitCode !== 0
		? "failed"
		: result.kind;
}

export type OmissionSpan = { start: number; end: number };

/** Never join bytes across a retained-output gap as if they were contiguous. */
function taskOutputBytes(page: OutputPage, omissions?: OmissionSpan[]): Buffer {
	const segments = [
		...page.chunks.map((chunk) => ({ start: chunk.offsets.start, bytes: Buffer.from(chunk.bytes), omitted: false })),
		...page.omittedRanges.map((range) => ({
			start: range.start,
			bytes: Buffer.from(`\n[Output omitted: bytes ${range.start}-${range.end}]\n`),
			omitted: true,
		})),
	].sort((a, b) => (BigInt(a.start) < BigInt(b.start) ? -1 : BigInt(a.start) > BigInt(b.start) ? 1 : 0));
	let offset = 0;
	return Buffer.concat(
		segments.map(({ bytes, omitted }) => {
			if (omitted) omissions?.push({ start: offset, end: offset + bytes.length });
			offset += bytes.length;
			return bytes;
		}),
	);
}

export function taskOutputText(page: OutputPage): string {
	return taskOutputBytes(page).toString("utf8");
}

/** Only skip bytes if they belong to a valid scalar that started before the window. */
function cutScalarBytes(prefix: Buffer, tail: Buffer): number {
	const edge = Buffer.concat([prefix, tail.subarray(0, 3)]);
	for (let i = 0; i < prefix.length; i++) {
		const lead = edge[i]!;
		if (lead < 0xc2 || lead > 0xf4) continue;
		const end = i + (lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4);
		if (end > prefix.length && end <= edge.length && isUtf8(edge.subarray(i, end))) return end - prefix.length;
	}
	return 0;
}

/** Read only the requested window for display. A leading continuation byte needs up to three bytes of context. */
export async function readTaskOutputTail(
	supervisor: TaskSupervisor,
	task: TaskLease,
	range: OutputRange,
	onOmission?: (span: OmissionSpan) => void,
) {
	const page = await supervisor.readTaskOutput(task, range);
	if (!page.ok) return page;
	const gaps = onOmission && page.value.omittedRanges.length ? ([] as OmissionSpan[]) : undefined;
	const bytes = taskOutputBytes(page.value, gaps);
	let skip = 0;
	if ((bytes[0]! & 0xc0) === 0x80 && BigInt(range.start) > 0n) {
		const start = BigInt(range.start);
		const count = start < 3n ? start : 3n;
		// If this optional lookbehind is unavailable, the original page is still readable.
		const before = await supervisor
			.readTaskOutput(task, { start: String(start - count), maximumBytes: Number(count) })
			.catch(() => undefined);
		if (before?.ok) skip = cutScalarBytes(taskOutputBytes(before.value).subarray(-3), bytes);
	}
	let text = "";
	if (gaps && onOmission) {
		for (const { start, end } of gaps) {
			text += bytes.toString("utf8", skip, start);
			onOmission({ start: text.length, end: text.length + end - start });
			text += bytes.toString("ascii", start, end);
			skip = end;
		}
	}
	return {
		ok: true as const,
		value: { text: text + bytes.toString("utf8", skip), omitted: page.value.omittedRanges.length > 0 },
	};
}
