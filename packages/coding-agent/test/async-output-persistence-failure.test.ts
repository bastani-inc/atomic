import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../../../test/helpers/runtime.ts";
import { createAsyncOutputAppender } from "../src/core/tools/bash-async-output.ts";
import { PersistedOutputFile } from "../src/core/tools/persisted-output-file.ts";
import { getProtectedSessionTempDirs, resetSessionTempDirStateForTesting } from "../src/core/tools/session-temp-dir.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

const PERSIST_AFTER_BYTES = 16;
const ASYNC_OUTPUT_BOUND_BYTES = DEFAULT_MAX_BYTES + 256;
const MEMORY_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_REFUSAL_MEMORY_OVER_CONTROL_BYTES = 512 * 1024;

let sandbox: string;

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-async-persist-failure-")));
	resetSessionTempDirStateForTesting();
});

afterEach(() => {
	resetSessionTempDirStateForTesting();
	rmSync(sandbox, { recursive: true, force: true });
});

function refusedSessionTempDir(name: string): string {
	const blocker = join(sandbox, `${name}-not-a-directory`);
	writeFileSync(blocker, "file blocks directory creation");
	return join(blocker, "session");
}

describe("async output after spill persistence is refused", () => {
	it("keeps decoding split and final UTF-8 input without retaining a protection lease", async () => {
		const protectedBefore = [...getProtectedSessionTempDirs()];
		const job: { output: string; fullOutputPath?: string } = { output: "" };
		const appender = createAsyncOutputAppender(job, {
			persistAfterBytes: PERSIST_AFTER_BYTES,
			sessionTempDir: refusedSessionTempDir("decoder"),
		});
		const emoji = Buffer.from("🙂", "utf8");

		appender.append(Buffer.from("output that triggers refusal: ", "utf8"));
		appender.append(emoji.subarray(0, 2));
		appender.append(emoji.subarray(2));
		// TextDecoder emits U+FFFD for this incomplete sequence only when close()
		// performs its final decoder flush.
		appender.append(Buffer.from([0xe2]));
		await appender.close();

		assert.equal(job.fullOutputPath, undefined);
		assert.ok(job.output.includes("🙂"), "a character split after refusal is still decoded");
		assert.ok(job.output.endsWith("�"), "close still flushes an incomplete decoder tail");
		assert.deepEqual([...getProtectedSessionTempDirs()], protectedBefore, "close leaves no writer lease behind");
	});

	it("does not fail a finished command when the spill file cannot be closed", async () => {
		// A storage fault at close time used to reject out of `close()`, and
		// `bash-async-execution` turned that rejection into `job.status = "failed"`
		// for a command that had already exited 0 — inviting a caller to retry a
		// side-effecting command that in fact succeeded.
		const protectedBefore = [...getProtectedSessionTempDirs()];
		const closeFailure = new Error("simulated ENOSPC while flushing the spill file");
		const realClose = PersistedOutputFile.prototype.close;
		PersistedOutputFile.prototype.close = function failingClose(): Promise<void> {
			return Promise.reject(closeFailure);
		};

		const job: { output: string; fullOutputPath?: string } = { output: "" };
		try {
			const appender = createAsyncOutputAppender(job, {
				persistAfterBytes: PERSIST_AFTER_BYTES,
				sessionTempDir: join(sandbox, "close-failure-session"),
			});
			appender.append(Buffer.from("output long enough to open a real spill file", "utf8"));
			assert.ok(job.fullOutputPath, "the spill file opened before the close fault");

			await assert.doesNotReject(appender.close(), "a spill close fault must not reject");
		} finally {
			PersistedOutputFile.prototype.close = realClose;
		}

		assert.equal(job.fullOutputPath, undefined, "an unflushed spill path is never advertised");
		assert.ok(job.output.includes("output long enough"), "polling output survives the close fault");
		assert.deepEqual([...getProtectedSessionTempDirs()], protectedBefore, "the writer lease is still released");
	});

	it("keeps polling output bounded and does not retain the refused raw stream", () => {
		const packageRoot = dirname(moduleDir(import.meta.url));
		const scriptPath = join(sandbox, "memory-probe.ts");
		writeFileSync(
			scriptPath,
			`
const { mkdirSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { createAsyncOutputAppender } = await import(${JSON.stringify(join(packageRoot, "src/core/tools/bash-async-output.ts"))});

const sandbox = ${JSON.stringify(sandbox)};
const heldAppenders = [];
async function run(mode) {
	const blocker = join(sandbox, "memory-blocker");
	let sessionTempDir;
	if (mode === "refused") {
		writeFileSync(blocker, "not a directory");
		sessionTempDir = join(blocker, "session");
	} else {
		sessionTempDir = join(sandbox, "working-session");
		mkdirSync(sessionTempDir, { recursive: true });
	}

	const job = { output: "" };
	const appender = createAsyncOutputAppender(job, {
		persistAfterBytes: ${PERSIST_AFTER_BYTES},
		sessionTempDir,
	});
	const chunkBytes = 256 * 1024;
	for (let offset = 0; offset < ${MEMORY_STREAM_BYTES}; offset += chunkBytes) {
		const chunk = Buffer.alloc(chunkBytes, 0x61 + ((offset / chunkBytes) % 26));
		appender.append(chunk);
	}
	await appender.close();
	// Keep the closure reachable while memoryUsage() is sampled. Without this,
	// Bun can prove the appender is dead after close() and collect the very array
	// whose retention this probe is meant to detect.
	heldAppenders.push(appender);
	for (let attempt = 0; attempt < 3; attempt++) globalThis.gc?.();
	return {
		external: process.memoryUsage().external,
		outputBytes: Buffer.byteLength(job.output, "utf8"),
		output: job.output.slice(-160),
		fullOutputPath: job.fullOutputPath,
	};
}

const control = await run("working");
const refused = await run("refused");
process.stdout.write(JSON.stringify({ control, refused }));
`,
		);

		const result = spawnSyncCollect([bunExecutable(), "--expose-gc", scriptPath], { cwd: sandbox });
		assert.equal(result.exitCode, 0, `memory child failed: ${result.stderr}`);
		const { control, refused } = JSON.parse(result.stdout) as {
			control: { external: number; outputBytes: number; output: string; fullOutputPath?: string };
			refused: { external: number; outputBytes: number; output: string; fullOutputPath?: string };
		};

		assert.equal(refused.fullOutputPath, undefined);
		assert.ok(refused.output.includes("Output truncated at"), "polling still reports truncation");
		assert.ok(refused.outputBytes <= ASYNC_OUTPUT_BOUND_BYTES, `polling output grew to ${refused.outputBytes} bytes`);
		// Bun accounts Buffer backing stores under `external`; its `arrayBuffers`
		// counter remains zero even when live Buffers retain megabytes.
		assert.ok(
			refused.external - control.external <= MAX_REFUSAL_MEMORY_OVER_CONTROL_BYTES,
			`refused spill retained ${refused.external - control.external} bytes over the working control`,
		);
	});
});
