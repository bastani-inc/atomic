import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	processStartToken,
	readProcessStartToken,
	setNativeProcessCreationTimeForTesting,
	setProcessCreationTimeQueryForTesting,
} from "../src/core/process-start-token.js";

const windows = process.platform === "win32";
/** A process id no live process has: Windows assigns multiples of four, Linux ids stay below 2^22. */
const MISSING_PID = 2 ** 22 + 7;
const FAKE_PID = 2 ** 22 + 8;
const FAKE_CREATION_TIME = "132000000000000000";
const READ_DEADLINE_MS = 30_000;
const POWERSHELL_READS_TIMEOUT_MS = 60_000;
const FALLBACK_TIMEOUT_MS = 5_000;
const TIMER_SLACK_MS = 1_000;

let scratchDir: string | undefined;

function scratch(): string {
	scratchDir ??= mkdtempSync(join(tmpdir(), "atomic-process-start-"));
	return scratchDir;
}

function countedQuery() {
	const count = join(scratch(), "queries");
	const cwd = join(scratch(), "cwd");
	return {
		file: process.execPath,
		args: () => [
			"-e",
			`const fs = require("fs"); fs.appendFileSync(${JSON.stringify(count)}, "x"); fs.writeFileSync(${JSON.stringify(cwd)}, process.cwd()); setTimeout(() => console.log("${FAKE_CREATION_TIME}"), 300)`,
		],
	};
}

function queryCwd(): string {
	return readFileSync(join(scratch(), "cwd"), "utf8");
}

function queries(): number {
	const count = join(scratch(), "queries");
	return existsSync(count) ? readFileSync(count, "utf8").length : 0;
}

function runs(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function watchEventLoop(): { stop(): number } {
	let last = performance.now();
	let longestStallMs = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		longestStallMs = Math.max(longestStallMs, now - last);
		last = now;
	}, 5);
	return {
		stop: () => {
			clearInterval(timer);
			return Math.max(longestStallMs, performance.now() - last);
		},
	};
}

async function runningChild() {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	const exited = new Promise((resolve) => child.once("exit", resolve));
	await new Promise((resolve, reject) => child.once("spawn", resolve).once("error", reject));
	return {
		pid: child.pid!,
		stop: async () => {
			child.kill("SIGKILL");
			await exited;
		},
	};
}

afterEach(() => {
	setProcessCreationTimeQueryForTesting(undefined);
	setNativeProcessCreationTimeForTesting(undefined);
	if (scratchDir !== undefined) rmSync(scratchDir, { recursive: true, force: true });
	scratchDir = undefined;
});

describe("the start of a process of this host (#5141)", () => {
	test.skipIf(!windows)("the native module reads a running process's creation time on Windows (#5141)", async () => {
		const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
			processCreationTime: (pid: number) => string | null;
		};
		const own = binding.processCreationTime(process.pid);
		assert.match(own ?? "", /^\d+$/);
		assert.equal(binding.processCreationTime(process.pid), own);
		assert.equal(binding.processCreationTime(MISSING_PID), null);
		const child = await runningChild();
		try {
			const created = binding.processCreationTime(child.pid);
			assert.match(created ?? "", /^\d+$/);
			assert.ok(BigInt(created!) >= BigInt(own!), "a child is created after its parent");
		} finally {
			await child.stop();
		}
		assert.equal(binding.processCreationTime(child.pid), null);
	});

	test.skipIf(!windows && process.platform !== "linux")(
		"two processes have different starts, and a gone one has none (#5141)",
		async () => {
			const child = await runningChild();
			const own = processStartToken(process.pid);
			const theirs = processStartToken(child.pid);
			await child.stop();
			assert.match(own ?? "", /^[0-9a-f]{12}$/);
			assert.match(theirs ?? "", /^[0-9a-f]{12}$/);
			assert.notEqual(theirs, own);
			assert.equal(processStartToken(child.pid), undefined);
			assert.equal(processStartToken(MISSING_PID), undefined);
			assert.equal(processStartToken(0), undefined);
			assert.equal(processStartToken(-1), undefined);
		},
	);

	test.skipIf(!windows)(
		"without the native module, the start is read alike by PowerShell, and a gone process has none (#5141)",
		async () => {
			const child = await runningChild();
			try {
				const native = processStartToken(child.pid);
				const ownNative = processStartToken(process.pid);
				setNativeProcessCreationTimeForTesting(null);
				assert.equal(await readProcessStartToken(child.pid), native);
				assert.equal(processStartToken(child.pid), native);
				assert.equal(await readProcessStartToken(process.pid), ownNative);
				assert.equal(await readProcessStartToken(MISSING_PID), undefined);
			} finally {
				await child.stop();
			}
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"without the native module, reading a start never holds up the event loop (#5315)",
		async () => {
			const child = await runningChild();
			try {
				const native = processStartToken(child.pid);
				setNativeProcessCreationTimeForTesting(null);
				const loop = watchEventLoop();
				const started = performance.now();
				let start = processStartToken(child.pid);
				const heldMs = performance.now() - started;
				while (start === undefined && performance.now() - started < READ_DEADLINE_MS) {
					await sleep(10);
					start = processStartToken(child.pid);
				}
				const readMs = performance.now() - started;
				const longestStallMs = loop.stop();
				assert.equal(start, native);
				assert.ok(
					heldMs < readMs / 2,
					`the read held the main thread for ${Math.round(heldMs)} ms of its ${Math.round(readMs)} ms`,
				);
				assert.ok(
					longestStallMs < readMs / 2,
					`the event loop stalled for ${Math.round(longestStallMs)} ms of the read's ${Math.round(readMs)} ms`,
				);
			} finally {
				await child.stop();
			}
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"without the native module, reads of one process at once start one PowerShell (#5315)",
		async () => {
			setNativeProcessCreationTimeForTesting(null);
			setProcessCreationTimeQueryForTesting(countedQuery());
			const reads = [readProcessStartToken(FAKE_PID), readProcessStartToken(FAKE_PID)];
			assert.equal(processStartToken(FAKE_PID), undefined, "a synchronous read answers before PowerShell does");
			reads.push(readProcessStartToken(FAKE_PID));
			const starts = await Promise.all(reads);
			assert.match(starts[0] ?? "", /^[0-9a-f]{12}$/);
			assert.deepEqual(starts, [starts[0], starts[0], starts[0]]);
			assert.equal(processStartToken(FAKE_PID), starts[0], "and then answers with what PowerShell read");
			assert.equal(queries(), 1);
			await readProcessStartToken(FAKE_PID + 4);
			assert.equal(queries(), 2, "another process is read on its own");
			assert.equal(processStartToken(FAKE_PID), starts[0], "and the first one's start is still reused");
			assert.equal(queries(), 2);
			assert.equal(
				queryCwd().toLowerCase(),
				(process.env.SystemRoot ?? "").toLowerCase(),
				"PowerShell runs from the Windows directory, never holding the caller's",
			);
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"with the native module, reading a start starts no PowerShell (#5315)",
		async () => {
			setNativeProcessCreationTimeForTesting(() => FAKE_CREATION_TIME);
			setProcessCreationTimeQueryForTesting(countedQuery());
			assert.match(processStartToken(FAKE_PID) ?? "", /^[0-9a-f]{12}$/);
			assert.equal(await readProcessStartToken(FAKE_PID), processStartToken(FAKE_PID));
			assert.equal(queries(), 0);
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"without the native module, a PowerShell that does not answer within 5 seconds gives no start, and is stopped (#5315)",
		async () => {
			setNativeProcessCreationTimeForTesting(null);
			const pidFile = join(scratch(), "query.pid");
			setProcessCreationTimeQueryForTesting({
				file: process.execPath,
				args: () => [
					"-e",
					`const fs = require("fs"); if (fs.existsSync(${JSON.stringify(pidFile)})) console.log("${FAKE_CREATION_TIME}"); else { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); }`,
				],
			});
			const started = performance.now();
			assert.equal(await readProcessStartToken(FAKE_PID), undefined);
			assert.ok(performance.now() - started >= FALLBACK_TIMEOUT_MS - TIMER_SLACK_MS, "it waited for the bound");
			const query = Number(readFileSync(pidFile, "utf8"));
			const deadline = performance.now() + READ_DEADLINE_MS;
			while (runs(query) && performance.now() < deadline) await sleep(50);
			assert.equal(runs(query), false, "the query that did not answer was stopped");
			assert.match(
				(await readProcessStartToken(FAKE_PID)) ?? "",
				/^[0-9a-f]{12}$/,
				"a query that timed out is asked again, not given up on",
			);
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"without the native module, a query that cannot be started at all gives no start, and never throws (#5315)",
		async () => {
			setNativeProcessCreationTimeForTesting(null);
			setProcessCreationTimeQueryForTesting({ file: process.execPath, args: () => ["\0"] });
			assert.equal(processStartToken(FAKE_PID), undefined);
			assert.equal(await readProcessStartToken(FAKE_PID), undefined);
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"without the native module, this process's start is read once and kept (#5315)",
		async () => {
			const native = processStartToken(process.pid);
			setNativeProcessCreationTimeForTesting(null);
			assert.equal(await readProcessStartToken(process.pid), native);
			await sleep(5_500);
			assert.equal(processStartToken(process.pid), native);
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"without the native module, a start read is reused for a few seconds, then read again (#5141)",
		async () => {
			setNativeProcessCreationTimeForTesting(null);
			const child = await runningChild();
			const start = await readProcessStartToken(child.pid);
			assert.match(start ?? "", /^[0-9a-f]{12}$/);
			await child.stop();
			assert.equal(await readProcessStartToken(child.pid), start);
			assert.equal(processStartToken(child.pid), start);
			await sleep(5_500);
			// Read again, not the cached start: none, or, where Windows already gave the id to another process under load,
			// that process's start, which differs.
			assert.notEqual(await readProcessStartToken(child.pid), start);
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)(
		"without the native module, PowerShell that cannot be started is given up on (#5141)",
		async () => {
			setNativeProcessCreationTimeForTesting(null);
			const child = await runningChild();
			try {
				const path = process.env.PATH;
				process.env.PATH = "";
				let reading: Promise<string | undefined>;
				try {
					reading = readProcessStartToken(process.pid);
				} finally {
					process.env.PATH = path;
				}
				assert.equal(await reading, undefined);
				// Another process, whose start was never read, has none either: PowerShell is not tried again.
				assert.equal(processStartToken(child.pid), undefined);
				assert.equal(await readProcessStartToken(child.pid), undefined);
				setNativeProcessCreationTimeForTesting(null);
				assert.match((await readProcessStartToken(child.pid)) ?? "", /^[0-9a-f]{12}$/);
			} finally {
				await child.stop();
			}
		},
		POWERSHELL_READS_TIMEOUT_MS,
	);

	test.skipIf(!windows)("a native reader that fails or answers nonsense gives no start (#5141)", () => {
		setNativeProcessCreationTimeForTesting(() => {
			throw new Error("unreadable");
		});
		assert.equal(processStartToken(process.pid), undefined);
		setNativeProcessCreationTimeForTesting(() => "not a time");
		assert.equal(processStartToken(process.pid), undefined);
		setNativeProcessCreationTimeForTesting(() => null);
		assert.equal(processStartToken(process.pid), undefined);
		setNativeProcessCreationTimeForTesting(() => "0");
		assert.equal(processStartToken(process.pid), undefined);
		setNativeProcessCreationTimeForTesting(() => "x132000000000000000");
		assert.equal(processStartToken(process.pid), undefined);
		setNativeProcessCreationTimeForTesting(() => "132000000000000000x");
		assert.equal(processStartToken(process.pid), undefined);
		setNativeProcessCreationTimeForTesting(() => "132000000000000000");
		assert.match(processStartToken(process.pid) ?? "", /^[0-9a-f]{12}$/);
	});
});
