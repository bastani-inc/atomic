import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, test } from "vitest";
import { bunExecutable } from "../helpers/runtime.js";

const OUTPUT_GUARD = new URL("../../packages/coding-agent/src/core/output-guard.ts", import.meta.url).href;
const RECORD_BYTES = 8 * 1024 * 1024;
/**
 * How long the reader stalls, and the longest the writer's timer may stop meanwhile. A write that waited for the reader
 * would stop it for the whole stall. On a loaded runner, Bun's event loop goes over a second without a turn, whatever it
 * writes, so the bound sits between the two.
 */
const STALLED_READER_MS = 3_000;
const TIMER_GAP_BOUND_MS = 2_000;

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
// A control record goes to the pipe at once, ahead of records still queued behind an unfinished one: it is written once
// the reader has seen the start of the large record, so that record is already in the pipe.
await new Promise((resolve) => process.stdin.once("data", resolve));
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

function runWriter(executable: string, args: readonly string[]): Promise<WriterResult> {
	const child = spawn(executable, [...args, WRITER], { stdio: ["pipe", "pipe", "pipe"] });
	const chunks: Buffer[] = [];
	let stderr = "";
	let stalled = false;
	let seenLargeRecord = false;
	child.stdout.on("data", (chunk: Buffer) => {
		chunks.push(chunk);
		if (!seenLargeRecord && Buffer.concat(chunks).includes('{"index":1,')) {
			seenLargeRecord = true;
			child.stdin.end("the large record arrived\n");
		}
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
