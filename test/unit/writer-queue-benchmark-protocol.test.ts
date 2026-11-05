import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import {
	isWriterQueueBenchmarkConfigError,
	isWriterQueueBenchmarkError,
	isWriterQueueBenchmarkWorkerError,
	WriterQueueBenchmarkConfigError,
	WriterQueueBenchmarkError,
	WriterQueueBenchmarkWorkerError,
} from "../../scripts/perf/writer-queue/errors.js";
import { parseBenchmarkOptions, parseDeadHeadOptions, storagePath } from "../../scripts/perf/writer-queue/options.js";
import {
	parseFlags,
	parseNumber,
	parseNumberList,
	reportFailure,
	verifyBaseline,
	verifyOutputPath,
	WorkerChannel,
	withCleanup,
} from "../../scripts/perf/writer-queue/support.js";
import {
	bunExecutable,
	makeTempDirectory,
	readDirectorySync,
	removeTempDirectory,
	spawnSyncCollect,
	writeTextSync,
} from "../helpers/runtime.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const scripts = join(repository, "scripts/perf/writer-queue");

function worker(script: string, label = "w"): WorkerChannel {
	return new WorkerChannel(spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "ignore"] }), label);
}

function workerOnPipe3(script: string, label = "w"): WorkerChannel {
	const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "ignore", "ignore", "pipe"] });
	Object.defineProperty(child, "stdout", { value: child.stdio[3] });
	return new WorkerChannel(child, label);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	return assert.fail("expected a rejection");
}

test("closing a writer releases its pending output-EOF timer (#4316)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const channel = worker("process.exit(0)");
	try {
		await channel.finished("exit");
		assert.equal(vi.getTimerCount(), 0);
	} finally {
		vi.useRealTimers();
		await channel.stop();
	}
});

test("a read pending on a writer that exits before printing rejects with a typed worker error (#4316)", async () => {
	const channel = worker("process.exit(3)");
	const error = await rejection(channel.next("ready"));
	assert.ok(isWriterQueueBenchmarkWorkerError(error));
	assert.ok(error instanceof WriterQueueBenchmarkWorkerError);
	assert.equal(error.code, "worker-exited");
	assert.equal(error.phase, "ready");
	assert.equal(error.exitCode, 3);
	assert.equal(error.worker, "w");
	assert.equal("cause" in error, false);
	assert.ok(isWriterQueueBenchmarkError(error));
});

test("a read made after the writer already exited rejects instead of waiting (#4316)", async () => {
	const channel = worker("process.exit(0)");
	await channel.finished("exit");
	const error = await rejection(channel.next("report"));
	assert.ok(isWriterQueueBenchmarkWorkerError(error));
	assert.equal(error.code, "worker-exited");
	assert.equal(error.phase, "report");
	assert.throws(() => channel.assertRunning("queue ticket"), isWriterQueueBenchmarkWorkerError);
});

test("lines printed before a writer exits are still delivered, in order, before the failure (#4316)", async () => {
	const channel = worker("process.stdout.write('ready\\nsecond\\n'); process.exit(1)");
	assert.equal(await channel.next("ready"), "ready");
	assert.equal(await channel.next("second"), "second");
	const error = await rejection(channel.next("third"));
	assert.ok(isWriterQueueBenchmarkWorkerError(error));
	assert.equal(error.phase, "third");
	assert.equal(error.exitCode, 1);
});

test("a writer that cannot be started rejects its reads with code worker-error and keeps the cause (#4316)", async () => {
	const channel = new WorkerChannel(
		spawn(join(tmpdir(), "no-such-writer-binary"), [], { stdio: ["pipe", "pipe", "ignore"] }),
		"missing",
	);
	const error = await rejection(channel.next("ready"));
	assert.ok(isWriterQueueBenchmarkWorkerError(error));
	assert.equal(error.code, "worker-error");
	assert.equal(error.worker, "missing");
	assert.equal(error.phase, "ready");
	assert.ok(error.cause instanceof Error);
	await assert.rejects(channel.finished("exit"), isWriterQueueBenchmarkWorkerError);
});

test("a writer terminated by stop() rejects its pending read as worker-exited with a termination status, and finished() rejects for a non-zero exit (#4316)", async () => {
	const killed = worker("setInterval(() => {}, 1000)");
	const pending = rejection(killed.next("ready"));
	await killed.stop();
	const error = await pending;
	assert.ok(isWriterQueueBenchmarkWorkerError(error));
	assert.equal(error.code, "worker-exited");
	assert.equal(error.phase, "ready");
	assert.equal(error.exitCode, null);
	assert.equal(error.signal, "SIGKILL");

	const signalled = await rejection(killed.finished("exit"));
	assert.ok(isWriterQueueBenchmarkWorkerError(signalled) && signalled.code === "worker-exited");

	const failed = worker("process.exit(2)");
	const outcome = await rejection(failed.finished("exit"));
	assert.ok(isWriterQueueBenchmarkWorkerError(outcome));
	assert.equal(outcome.exitCode, 2);
	await failed.stop();
});

test("failed cleanup rides on the primary failure instead of replacing it (#4316)", async () => {
	const primary = new WriterQueueBenchmarkWorkerError("worker-exited", { worker: "p0", phase: "ready", exitCode: 1 });
	const cleanupFailure = new Error("cleanup failed");
	const error = await rejection(
		withCleanup(
			async () => {
				throw primary;
			},
			() => {
				throw cleanupFailure;
			},
		),
	);
	assert.equal(error, primary);
	assert.equal((error as { cleanupCause?: unknown }).cleanupCause, cleanupFailure);
});

test("a writer that closes its output while still running rejects pending and later reads, after delivering earlier lines (#4316)", async () => {
	const channel = workerOnPipe3(
		"const fs = require('fs'); fs.writeSync(3, 'first\\n'); fs.closeSync(3); setInterval(() => {}, 1000)",
	);
	assert.equal(await channel.next("first"), "first");
	const pending = await rejection(channel.next("second"));
	assert.ok(isWriterQueueBenchmarkWorkerError(pending));
	assert.equal(pending.code, "worker-protocol");
	assert.equal(pending.phase, "second");
	assert.equal(pending.exitCode, null);
	const later = await rejection(channel.next("third"));
	assert.ok(isWriterQueueBenchmarkWorkerError(later) && later.phase === "third" && later.code === "worker-protocol");
	assert.throws(() => channel.assertRunning("queue ticket"), isWriterQueueBenchmarkWorkerError);
	await channel.stop();
});

test("a stdout stream error rejects the pending read with that error as the cause instead of going unhandled (#4316)", async () => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "ignore"] });
	const channel = new WorkerChannel(child, "w");
	const pending = rejection(channel.next("ready"));
	const failure = new Error("read failed");
	child.stdout!.emit("error", failure);
	const error = await pending;
	assert.ok(isWriterQueueBenchmarkWorkerError(error));
	assert.equal(error.cause, failure);
	await channel.stop();
});

test("cleanup runs after success and after failure (#4316)", async () => {
	let cleanups = 0;
	assert.equal(
		await withCleanup(
			async () => "done",
			() => {
				cleanups += 1;
			},
		),
		"done",
	);
	await rejection(
		withCleanup(
			async () => {
				throw new Error("boom");
			},
			() => {
				cleanups += 1;
			},
		),
	);
	assert.equal(cleanups, 2);
});

test("a primary failure that cannot carry the cleanup failure is still thrown, with the cleanup failure reported once (#4316)", async () => {
	const failing = () => {
		throw new Error("cleanup failed");
	};
	const frozen = Object.freeze(new Error("primary"));
	const written: string[] = [];
	vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	}) as typeof process.stderr.write);
	assert.equal(
		await rejection(
			withCleanup(async () => {
				throw frozen;
			}, failing),
		),
		frozen,
	);
	assert.deepEqual(written, ["Cleanup after the failure also failed: Error: cleanup failed\n"]);

	const first = new Error("primary");
	Object.defineProperty(first, "cleanupCause", { value: "earlier" });
	assert.equal(
		await rejection(
			withCleanup(async () => {
				throw first;
			}, failing),
		),
		first,
	);
	assert.equal((first as { cleanupCause?: unknown }).cleanupCause, "earlier");
	assert.equal(written.length, 2);

	assert.equal(
		await rejection(
			withCleanup(async () => {
				throw "primitive";
			}, failing),
		),
		"primitive",
	);
	assert.equal(written.length, 3);

	assert.equal(
		await rejection(
			withCleanup(async () => {
				throw null;
			}, failing),
		),
		null,
	);
	assert.equal(written.length, 4);
});

test("a worker error carries typed fields, is not retryable, and renders its UX message once (#4316)", () => {
	const cause = new Error("pipe");
	const error = new WriterQueueBenchmarkWorkerError(
		"worker-exited",
		{ worker: "p3", phase: "ready", exitCode: 1 },
		{ cause },
	);
	assert.ok(error instanceof WriterQueueBenchmarkError);
	assert.equal(error.name, "WriterQueueBenchmarkWorkerError");
	assert.equal(error.retryable, false);
	assert.equal(error.cause, cause);
	assert.equal(
		error.message,
		"Benchmark worker p3 exited with code 1 while the benchmark waited for ready (worker-exited). Read the worker's own error printed above on stderr, fix it, and rerun",
	);
	assert.equal(error.hint, "Read the worker's own error printed above on stderr, fix it, and rerun");
});

test("worker error codes name their outcome and keep exit details apart (#4316)", () => {
	const signalled = new WriterQueueBenchmarkWorkerError("worker-exited", {
		worker: "a",
		phase: "report",
		signal: "SIGKILL",
	});
	assert.equal(signalled.signal, "SIGKILL");
	assert.equal(signalled.exitCode, null);
	assert.match(signalled.message, /exited on SIGKILL/);
	const unknown = new WriterQueueBenchmarkWorkerError("worker-exited", { worker: "a", phase: "report" });
	assert.match(unknown.message, /exited with code unknown/);
	assert.match(
		new WriterQueueBenchmarkWorkerError("worker-error", { worker: "a", phase: "x" }).message,
		/could not run/,
	);
	assert.match(
		new WriterQueueBenchmarkWorkerError("worker-protocol", { worker: "a", phase: "x" }).message,
		/broke the line protocol/,
	);
});

test("a config error names the cli source, field and reason, and the base error omits an absent hint (#4316)", () => {
	const error = new WriterQueueBenchmarkConfigError("--holds", "out-of-range", "Pass a number");
	assert.equal(error.name, "WriterQueueBenchmarkConfigError");
	assert.equal(error.code, "invalid-option");
	assert.equal(error.source, "cli");
	assert.equal(error.field, "--holds");
	assert.equal(error.reason, "out-of-range");
	assert.equal(error.retryable, false);
	assert.equal(error.hint, "Pass a number");
	assert.equal(error.message, "Invalid benchmark option: --holds (out-of-range) (invalid-option). Pass a number");
	const bare = new WriterQueueBenchmarkError("invalid-option", "Plain");
	assert.equal(bare.name, "WriterQueueBenchmarkError");
	assert.equal(bare.message, "Plain (invalid-option)");
	assert.equal("hint" in bare, false);
});

test("guards match instances and serialized lookalikes by class, name and code, and nothing else (#4316)", () => {
	const worker = new WriterQueueBenchmarkWorkerError("worker-protocol", { worker: "a", phase: "x" });
	const config = new WriterQueueBenchmarkConfigError("--x", "unknown-flag");
	assert.ok(isWriterQueueBenchmarkWorkerError(worker) && !isWriterQueueBenchmarkConfigError(worker));
	assert.ok(isWriterQueueBenchmarkConfigError(config) && !isWriterQueueBenchmarkWorkerError(config));
	assert.ok(isWriterQueueBenchmarkError(worker) && isWriterQueueBenchmarkError(config));
	assert.ok(isWriterQueueBenchmarkError(new WriterQueueBenchmarkError("worker-error", "Base")));
	for (const code of ["invalid-option", "worker-exited", "worker-error", "worker-protocol"])
		assert.ok(isWriterQueueBenchmarkError({ name: "WriterQueueBenchmarkError", code }));
	for (const code of ["worker-exited", "worker-error", "worker-protocol"])
		assert.ok(isWriterQueueBenchmarkWorkerError({ name: "WriterQueueBenchmarkWorkerError", code }));
	assert.ok(isWriterQueueBenchmarkConfigError({ name: "WriterQueueBenchmarkConfigError", code: "invalid-option" }));
	assert.ok(isWriterQueueBenchmarkError({ name: "WriterQueueBenchmarkConfigError", code: "invalid-option" }));
	for (const other of [
		{ name: "WriterQueueBenchmarkWorkerError", code: "invalid-option" },
		{ name: "WriterQueueBenchmarkWorkerError", code: 7 },
		{ name: "WriterQueueBenchmarkWorkerError" },
		{ name: "Error", code: "worker-exited" },
		{ name: "WriterQueueBenchmarkConfigError", code: "worker-exited" },
		{ name: "WriterQueueBenchmarkError", code: "unknown" },
		null,
		undefined,
		"WriterQueueBenchmarkWorkerError",
	])
		assert.ok(!isWriterQueueBenchmarkError(other), JSON.stringify(other));
	assert.ok(!isWriterQueueBenchmarkError({ name: "WriterQueueBenchmarkWorkerError", code: "invalid-option" }));
	assert.ok(!isWriterQueueBenchmarkConfigError({ name: "WriterQueueBenchmarkConfigError", code: "worker-exited" }));
	assert.ok(!isWriterQueueBenchmarkError(null));
	assert.ok(!isWriterQueueBenchmarkError("WriterQueueBenchmarkWorkerError"));
});

function configFailure(run: () => unknown): WriterQueueBenchmarkConfigError {
	try {
		run();
	} catch (error) {
		assert.ok(isWriterQueueBenchmarkConfigError(error), String(error));
		return error;
	}
	return assert.fail("expected a config error");
}

test("parseFlags returns every pair and rejects stray, unknown, repeated and valueless flags with the flag named (#4316)", () => {
	assert.deepEqual(
		[...parseFlags(["--a", "1", "--b", "-2"], ["a", "b"])],
		[
			["a", "1"],
			["b", "-2"],
		],
	);
	assert.equal(parseFlags([], ["a"]).size, 0);
	for (const [argv, field, reason] of [
		[["stray"], "stray", "unexpected-argument"],
		[["--zzz", "1"], "--zzz", "unknown-flag"],
		[["--a", "1", "--a", "2"], "--a", "repeated-flag"],
		[["--a"], "--a", "missing-value"],
		[["--a", "--b", "1"], "--a", "missing-value"],
	] as const) {
		const error = configFailure(() => parseFlags(argv, ["a", "b"]));
		assert.equal(error.field, field);
		assert.equal(error.reason, reason);
		assert.ok(error.hint !== undefined && error.hint.length > 0);
	}
});

test("parseNumber accepts the bound and rejects non-numbers, blanks, infinities, below-minimum and fractional values (#4316)", () => {
	assert.equal(parseNumber("--x", "0", { min: 0, unit: "ms" }), 0);
	assert.equal(parseNumber("--x", " 2.5 ", { min: 1, unit: "ms" }), 2.5);
	assert.equal(parseNumber("--x", "3", { min: 1, integer: true, unit: "reps" }), 3);
	assert.deepEqual(parseNumberList("--x", "0,25", { min: 0, unit: "ms" }), [0, 25]);
	for (const [text, rule] of [
		["-1", { min: 0, unit: "ms" }],
		["abc", { min: 0, unit: "ms" }],
		["", { min: 0, unit: "ms" }],
		["  ", { min: 0, unit: "ms" }],
		["Infinity", { min: 0, unit: "ms" }],
		["NaN", { min: 0, unit: "ms" }],
		["0.5", { min: 1, unit: "ms" }],
		["1.5", { min: 1, integer: true, unit: "reps" }],
	] as const) {
		const error = configFailure(() => parseNumber("--x", text, rule));
		assert.equal(error.field, "--x");
		assert.equal(error.reason, "out-of-range");
	}
	assert.match(
		configFailure(() => parseNumber("--x", "0", { min: 1, integer: true, unit: "reps" })).message,
		/whole number of reps, 1 or more/,
	);
	assert.match(
		configFailure(() => parseNumber("--x", "0", { min: 1, unit: "ms" })).message,
		/finite number of ms, 1 or more/,
	);
	assert.equal(configFailure(() => parseNumberList("--x", "1,,2", { min: 0, unit: "ms" })).field, "--x");
});

test("verifyBaseline accepts a commit with the storage sources and names the flag otherwise (#4316)", () => {
	verifyBaseline("--baseline", "HEAD", storagePath, repository);
	const unknown = configFailure(() => verifyBaseline("--baseline", "no-such-revision-4316", storagePath, repository));
	assert.equal(unknown.reason, "unknown-revision");
	assert.equal(unknown.field, "--baseline");
	assert.equal(
		configFailure(() => verifyBaseline("--baseline", "", storagePath, repository)).reason,
		"unknown-revision",
	);
	assert.equal(
		configFailure(() => verifyBaseline("--baseline", "-x", storagePath, repository)).reason,
		"unknown-revision",
	);
	const missing = configFailure(() => verifyBaseline("--baseline", "HEAD", "no/such/directory", repository));
	assert.equal(missing.reason, "missing-storage-directory");
	assert.match(missing.message, /HEAD/);
});

test("verifyBaseline reports git itself missing before checking the revision (#4316)", () => {
	const path = process.env.PATH;
	process.env.PATH = "";
	try {
		const error = configFailure(() => verifyBaseline("--baseline", "HEAD", storagePath, repository));
		assert.equal(error.reason, "git-unavailable");
		assert.equal(error.field, "git");
		assert.equal(error.hint, "Install git and put it on PATH; the benchmark reads the baseline revision from it");
		assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOENT");
	} finally {
		process.env.PATH = path;
	}
});

test("verifyOutputPath resolves a writable file path and rejects a directory or a file parent (#4316)", () => {
	const directory = makeTempDirectory("wq-output-test-");
	try {
		writeTextSync(join(directory, "existing.json"), "{}");
		assert.equal(verifyOutputPath("--out", join(directory, "existing.json")), join(directory, "existing.json"));
		assert.equal(
			verifyOutputPath("--out", join(directory, "new", "result.json")),
			join(directory, "new", "result.json"),
		);
		assert.equal(configFailure(() => verifyOutputPath("--out", directory)).reason, "not-a-file-path");
		assert.equal(
			configFailure(() => verifyOutputPath("--out", join(directory, "existing.json", "result.json"))).field,
			"--out",
		);
	} finally {
		removeTempDirectory(directory);
	}
});

const scenarios = [{ name: "alpha" }, { name: "beta" }];

test("benchmark options default every value, validate each flag, and resolve scenario names (#4316)", () => {
	const defaults = parseBenchmarkOptions([], scenarios);
	assert.deepEqual(defaults.scenarios, scenarios);
	assert.deepEqual(defaults.holds, [25, 50, 100, 200, 400]);
	assert.equal(defaults.repeats, 3);
	assert.equal(defaults.warmupMs, 1000);
	assert.equal(defaults.measureMs, 8000);
	assert.equal(defaults.baseline, "77746f5");
	assert.equal(defaults.runtime, "node");
	assert.equal("out" in defaults, false);
	const chosen = parseBenchmarkOptions(
		[
			"--scenarios",
			"beta",
			"--holds",
			"0,5",
			"--repeats",
			"1",
			"--warmup",
			"0",
			"--measure",
			"1",
			"--runtime",
			"bun",
			"--out",
			"result.json",
		],
		scenarios,
	);
	assert.deepEqual(chosen.scenarios, [scenarios[1]]);
	assert.deepEqual(chosen.holds, [0, 5]);
	assert.equal(chosen.repeats, 1);
	assert.equal(chosen.warmupMs, 0);
	assert.equal(chosen.measureMs, 1);
	assert.equal(chosen.runtime, "bun");
	assert.equal(chosen.out, join(process.cwd(), "result.json"));
});

test("benchmark options reject --holds -1 and every other bad flag by field and reason before any side effect (#4316)", () => {
	for (const [argv, field, reason] of [
		[["--holds", "-1"], "--holds", "out-of-range"],
		[["--holds", "25,abc"], "--holds", "out-of-range"],
		[["--repeats", "0"], "--repeats", "out-of-range"],
		[["--warmup", "-5"], "--warmup", "out-of-range"],
		[["--measure", "0"], "--measure", "out-of-range"],
		[["--scenarios", "gamma"], "--scenarios", "unknown-scenario"],
		[["--scenarios", "alpha,gamma"], "--scenarios", "unknown-scenario"],
		[["--runtime", "deno"], "--runtime", "unknown-runtime"],
		[["--baseline", "no-such-revision-4316"], "--baseline", "unknown-revision"],
		[["--out", tmpdir()], "--out", "not-a-file-path"],
		[["--bogus", "1"], "--bogus", "unknown-flag"],
	] as const) {
		const error = configFailure(() => parseBenchmarkOptions(argv, scenarios));
		assert.equal(error.field, field);
		assert.equal(error.reason, reason);
	}
});

test("dead-head options default, validate and reject bad flags (#4316)", () => {
	assert.deepEqual(parseDeadHeadOptions([]), { gaps: [100, 1000, 1500], repeats: 5, baseline: "77746f5" });
	assert.deepEqual(parseDeadHeadOptions(["--gaps", "0,10", "--repeats", "2", "--baseline", "HEAD"]), {
		gaps: [0, 10],
		repeats: 2,
		baseline: "HEAD",
	});
	for (const [argv, field] of [
		[["--gaps", "-1"], "--gaps"],
		[["--repeats", "x"], "--repeats"],
		[["--baseline", "no-such-revision-4316"], "--baseline"],
		[["--holds", "1"], "--holds"],
	] as const)
		assert.equal(configFailure(() => parseDeadHeadOptions(argv)).field, field);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
	delete process.env.ATOMIC_PERF_DEBUG;
});

function captureStderr(run: () => void): string {
	const chunks: string[] = [];
	vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stderr.write);
	run();
	return chunks.join("");
}

test("reportFailure prints the message once, sets a failing exit code, and shows the stack only when debugging (#4316)", () => {
	const error = new WriterQueueBenchmarkConfigError("--holds", "out-of-range", "Pass a number");
	assert.equal(
		captureStderr(() => reportFailure(error)),
		`${error.message}\n`,
	);
	assert.equal(process.exitCode, 1);
	assert.equal(
		captureStderr(() => reportFailure("plain text")),
		"plain text\n",
	);
	process.env.ATOMIC_PERF_DEBUG = "1";
	assert.equal(
		captureStderr(() => reportFailure(error)),
		`${error.message}\n${error.stack}\n`,
	);
	delete error.stack;
	assert.equal(
		captureStderr(() => reportFailure(error)),
		`${error.message}\n`,
	);
});

test("reportFailure mentions a cleanup failure that followed the primary one (#4316)", () => {
	const error = new WriterQueueBenchmarkWorkerError("worker-exited", { worker: "p0", phase: "ready", exitCode: 1 });
	Object.defineProperty(error, "cleanupCause", { value: "disk busy" });
	assert.match(
		captureStderr(() => reportFailure(error)),
		/\nCleanup after the failure also failed: disk busy\n$/,
	);
});

test("sending to a writer that already exited neither throws nor crashes, and its pid is exposed (#4316)", async () => {
	const channel = worker("process.exit(0)");
	assert.equal(typeof channel.pid, "number");
	await channel.finished("exit");
	channel.send("go");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.ok(isWriterQueueBenchmarkWorkerError(await rejection(channel.next("x"))));
});

test("reads resolve in order across lines split over chunks and pending reads (#4316)", async () => {
	const channel = worker("process.stdout.write('a'); setTimeout(() => process.stdout.write('b\\nc\\n'), 30)");
	const first = channel.next("first");
	const second = channel.next("second");
	assert.equal(await first, "ab");
	assert.equal(await second, "c");
	await channel.finished("exit");
});

function runScript(name: string, args: readonly string[], env: Record<string, string> = {}) {
	const temp = makeTempDirectory("wq-cli-test-");
	try {
		const result = spawnSyncCollect([bunExecutable(), "run", join(scripts, name), ...args], {
			cwd: repository,
			timeout: 60_000,
			env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, ...env },
		});
		return {
			status: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
			leftovers: readDirectorySync(temp),
		};
	} finally {
		removeTempDirectory(temp);
	}
}

test("the benchmark CLI rejects --holds -1 at once with a typed message, exit 1 and no scratch directory (#4316)", () => {
	const result = runScript("benchmark.ts", ["--holds", "-1", "--scenarios", "uncontended"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /\(invalid-option\)/);
	assert.match(result.stderr, /--holds/);
	assert.doesNotMatch(result.stderr, /\n\s+at /);
	assert.equal(result.stdout, "");
	assert.deepEqual(result.leftovers, []);
});

const REAL_WRITER_QUEUE_CLI_TEST_TIMEOUT_MS = 90_000;

test(
	"the benchmark CLI fails fast instead of hanging when its writers exit before ready, and cleans up (#4316)",
	() => {
		const result = runScript("benchmark.ts", ["--scenarios", "serial-30", "--holds", "25", "--repeats", "1"], {
			NODE_OPTIONS: "--no-such-flag",
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /\(worker-exited\)/);
		assert.match(result.stderr, /waited for ready/);
		assert.doesNotMatch(result.stderr, /\n\s+at /);
		assert.deepEqual(result.leftovers, []);
	},
	REAL_WRITER_QUEUE_CLI_TEST_TIMEOUT_MS,
);

test(
	"the dead-head CLI fails fast instead of hanging when its holder exits before locking, and cleans up (#4316)",
	() => {
		const result = runScript("dead-head.ts", ["--gaps", "0", "--repeats", "1"], { NODE_OPTIONS: "--no-such-flag" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /\(worker-exited\)/);
		assert.match(result.stderr, /waited for locked/);
		assert.deepEqual(result.leftovers, []);
	},
	REAL_WRITER_QUEUE_CLI_TEST_TIMEOUT_MS,
);

test("the dead-head CLI rejects a bad flag before starting anything (#4316)", () => {
	const result = runScript("dead-head.ts", ["--gaps", "-1"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /--gaps/);
});

test("flag, number, baseline and output errors tell the user exactly what to change (#4316)", () => {
	const hintOf = (run: () => unknown) => configFailure(run).hint;
	assert.equal(
		hintOf(() => parseFlags(["stray"], ["a", "b"])),
		"Pass options as flag value pairs: --a, --b",
	);
	assert.equal(
		hintOf(() => parseFlags(["--zzz", "1"], ["a", "b"])),
		"Supported flags: --a, --b",
	);
	assert.equal(
		hintOf(() => parseFlags(["--a", "1", "--a", "2"], ["a"])),
		"Pass --a once",
	);
	assert.equal(
		hintOf(() => parseFlags(["--a"], ["a"])),
		"Pass a value after --a",
	);
	assert.equal(
		hintOf(() => parseNumber("--x", "-1", { min: 0, unit: "ms" })),
		"Pass --x as a finite number of ms, 0 or more",
	);
	assert.equal(
		hintOf(() => verifyBaseline("--baseline", "no-such-revision-4316", storagePath, repository)),
		"Pass --baseline as a commit, tag, or branch that exists in this checkout",
	);
	assert.equal(
		hintOf(() => verifyBaseline("--baseline", "HEAD", "no/such/directory", repository)),
		"Pass --baseline as a revision that already has the storage sources; HEAD does not",
	);
	assert.equal(
		hintOf(() => verifyOutputPath("--out", tmpdir())),
		"Pass --out as a file path whose parent is a directory",
	);
});

test("verifyBaseline asks git about the checkout it is given, not the current directory (#4316)", () => {
	const elsewhere = makeTempDirectory("wq-no-git-");
	try {
		const error = configFailure(() => verifyBaseline("--baseline", "HEAD", storagePath, elsewhere));
		assert.equal(error.reason, "unknown-revision");
	} finally {
		removeTempDirectory(elsewhere);
	}
});

test("the storage path the benchmarks copy and load is where the node-sqlite adapter lives (#4316)", () => {
	assert.ok(readDirectorySync(join(repository, storagePath)).includes("node-sqlite.ts"));
});

test("benchmark and dead-head options reject each bad flag with the exact hint to fix it, including fractional repeats (#4316)", () => {
	const hints: [() => unknown, string][] = [
		[() => parseBenchmarkOptions(["--scenarios", "gamma"], scenarios), "Supported scenarios: alpha, beta"],
		[() => parseBenchmarkOptions(["--runtime", "deno"], scenarios), "Pass --runtime node or --runtime bun"],
		[
			() => parseBenchmarkOptions(["--holds", "-1"], scenarios),
			"Pass --holds as a finite number of milliseconds, 0 or more",
		],
		[
			() => parseBenchmarkOptions(["--repeats", "1.5"], scenarios),
			"Pass --repeats as a whole number of repetitions, 1 or more",
		],
		[
			() => parseBenchmarkOptions(["--warmup", "-1"], scenarios),
			"Pass --warmup as a finite number of milliseconds, 0 or more",
		],
		[
			() => parseBenchmarkOptions(["--measure", "0"], scenarios),
			"Pass --measure as a finite number of milliseconds, 1 or more",
		],
		[() => parseDeadHeadOptions(["--gaps", "-1"]), "Pass --gaps as a finite number of milliseconds, 0 or more"],
		[() => parseDeadHeadOptions(["--repeats", "0"]), "Pass --repeats as a whole number of repetitions, 1 or more"],
		[() => parseDeadHeadOptions(["--repeats", "2.5"]), "Pass --repeats as a whole number of repetitions, 1 or more"],
	];
	for (const [run, hint] of hints) assert.equal(configFailure(run).hint, hint);
});

test("send delivers its line, with a newline, to the writer's stdin and closes it (#4316)", async () => {
	const channel = worker(
		"let t=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { t += d; }); process.stdin.on('end', () => process.stdout.write('got ' + JSON.stringify(t) + '\\n'))",
	);
	channel.send("hello");
	assert.equal(await channel.next("echo"), 'got "hello\\n"');
	await channel.finished("exit");
});

test("assertRunning passes while the writer runs and throws once it has ended (#4316)", async () => {
	const channel = worker("setInterval(() => {}, 1000)");
	channel.assertRunning("queue ticket");
	await channel.stop();
	assert.throws(() => channel.assertRunning("queue ticket"), isWriterQueueBenchmarkWorkerError);
});

test("a stdin stream error is kept as the cause of the later worker failure (#4316)", async () => {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(1), 100)"], {
		stdio: ["pipe", "pipe", "ignore"],
	});
	const channel = new WorkerChannel(child, "w");
	const pending = rejection(channel.next("ready"));
	const failure = new Error("write failed");
	child.stdin!.emit("error", failure);
	const error = await pending;
	assert.ok(isWriterQueueBenchmarkWorkerError(error));
	assert.equal(error.code, "worker-exited");
	assert.equal(error.cause, failure);
});
