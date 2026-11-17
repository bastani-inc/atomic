/**
 * A protocol process writing to its stdout pipe keeps its event loop turning while the reader on the other end stops
 * reading, and the reader still receives every record whole and in order.
 *
 * The isolated engine sends the interactive host megabytes of frames when a long session resumes, while the host is
 * busy drawing it. On Windows, Node and Bun write to a stdout pipe synchronously: a write that does not fit the pipe's
 * buffer holds the writer's thread until the reader has taken the rest.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, test } from "vitest";
import { bunExecutable } from "../helpers/runtime.js";

const OUTPUT_GUARD = new URL("../../packages/coding-agent/src/core/output-guard.ts", import.meta.url).href;
/** Far more than any pipe buffers: the record cannot leave while the reader has stopped. */
const RECORD_BYTES = 8 * 1024 * 1024;
/** How long the reader stops reading once the first bytes arrive. */
const STALLED_READER_MS = 1_500;
/**
 * The longest the writer's 5 ms timer may go without firing. Windows timers tick every 15.6 ms and a loaded runner
 * adds to that; a writer held by the stalled reader shows the whole stall.
 */
const TIMER_GAP_BOUND_MS = 250;

/** Writes four records, the second of RECORD_BYTES and the third a control frame, and reports its timer's longest gap. */
const WRITER = `
const guard = await import(${JSON.stringify(OUTPUT_GUARD)});
guard.takeOverStdout({ nonBlockingPipe: true });
const record = (index, payload) => JSON.stringify({ index, payload }) + "\\n";
let last = performance.now();
let maxGapMs = 0;
const ticker = setInterval(() => {
	const now = performance.now();
	maxGapMs = Math.max(maxGapMs, now - last);
	last = now;
}, 5);
const started = performance.now();
guard.writeRawStdout(record(0, "first"));
guard.writeRawStdout(record(1, "x".repeat(${RECORD_BYTES})));
await new Promise((resolve) => setTimeout(resolve, 50));
guard.writeRawStdoutControl(record(2, "control"));
guard.writeRawStdout(record(3, "last"));
await guard.flushRawStdout();
clearInterval(ticker);
process.stderr.write(JSON.stringify({ maxGapMs, elapsedMs: performance.now() - started }) + "\\n");
`;

interface WriterResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs the writer with its stdout piped here, and stops reading that pipe for STALLED_READER_MS after its first bytes. */
function runWriter(executable: string, args: readonly string[]): Promise<WriterResult> {
	const child = spawn(executable, [...args, WRITER], { stdio: ["ignore", "pipe", "pipe"] });
	const chunks: Buffer[] = [];
	let stderr = "";
	let stalled = false;
	child.stdout.on("data", (chunk: Buffer) => {
		chunks.push(chunk);
		if (stalled) return;
		stalled = true;
		child.stdout.pause();
		setTimeout(() => child.stdout.resume(), STALLED_READER_MS);
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (exitCode) => resolve({ exitCode, stdout: Buffer.concat(chunks).toString("utf8"), stderr }));
	});
}

describe("raw stdout to a pipe whose reader stalls", () => {
	test.each([
		["Node", process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e"]],
		["Bun", bunExecutable(), ["--eval"]],
	])(
		"keeps the writer's event loop turning and delivers every record whole and in order under %s",
		async (_runtime, executable, args) => {
			const result = await runWriter(executable, args);
			assert.equal(result.exitCode, 0, result.stderr);
			const report = JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "") as {
				maxGapMs: number;
				elapsedMs: number;
			};
			const records = result.stdout.split("\n");
			assert.equal(records.pop(), "", "the output ends with a complete record");
			assert.deepEqual(
				records.map((line) => JSON.parse(line) as { index: number; payload: string }),
				[
					{ index: 0, payload: "first" },
					{ index: 1, payload: "x".repeat(RECORD_BYTES) },
					{ index: 2, payload: "control" },
					{ index: 3, payload: "last" },
				],
			);
			assert.ok(
				report.elapsedMs >= STALLED_READER_MS / 2,
				`the records were written in ${report.elapsedMs} ms, so the reader's stall did not hold them`,
			);
			assert.ok(
				report.maxGapMs < TIMER_GAP_BOUND_MS,
				`the writer's timer stopped for ${report.maxGapMs} ms while the reader stalled`,
			);
		},
	);
});
