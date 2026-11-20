import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "vitest";
import { AsyncSubprocessError, runBunSubprocess } from "../../packages/web-access/subprocess.ts";
import { extractVideoFrame, getLocalVideoDuration } from "../../packages/web-access/video-extract.ts";
import { getYouTubeStreamInfo } from "../../packages/web-access/youtube-extract.ts";
import { inheritedPipes } from "../fixtures/web-subprocess-inherited-pipes.js";
import { bunExecutable, spawnSyncCollect } from "../helpers/runtime.js";

// #3111: descendants may retain both pipes after the direct child is killed.
test.each(["abort", "timeout", "overflow"] as const)("Node bounds inherited-pipe cleanup after %s", inheritedPipes);

/**
 * The ceiling for a child that has to start, run a short script and exit: what the tests check is how its exit is
 * mapped, or a budget the child measures itself, not how long the run takes. Starting Bun or Node on a loaded Windows
 * host has taken more than a second, which the former 1 s ceiling turned into a timeout.
 */
const CHILD_RUN_TIMEOUT_MS = 20_000;

test("Bun host bounds inherited-pipe cleanup and preserves primary errors", () => {
	const result = spawnSyncCollect([bunExecutable(), "test/fixtures/web-subprocess-inherited-pipes.ts", "run"], {
		timeout: 20_000,
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	assert.match(result.stdout.toString(), /inherited-pipes-ok/);
});

// #3105: exercise the shipped adapter under Node, without a synthetic Bun global.
test("Node subprocess adapter executes without Bun and preserves binary output", async () => {
	assert.equal(typeof globalThis.Bun, "undefined");
	const result = await runBunSubprocess(process.execPath, ["-e", "process.stdout.write(Buffer.from([0,255,1]))"], {
		timeoutMs: CHILD_RUN_TIMEOUT_MS,
		maxStdoutBytes: 1024,
	});
	assert.deepEqual([...result.stdout], [0, 255, 1]);
});

// Fake CLI tools for the command-path test are plain /bin/sh scripts, not Bun
// scripts. The first exec of a freshly written bun-shebang script stalls for
// multiple seconds on a loaded macOS machine (measured p50 3.6s, max 62s under
// a concurrent `test:unit` run, versus <210ms for a fresh /bin/sh script and
// <1s re-execing an already-run bun script), which blows through the shipped
// 10s ffprobe/ffmpeg budget in video-extract.ts and fails the test with
// "ffprobe timed out". The fixtures only echo fixed bytes, so the shell does
// the same job without dragging a Bun cold start inside the shipped timeout.
// The test returns early on win32, so POSIX sh is always available here.
function executable(path: string, body: string): void {
	writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
	chmodSync(path, 0o755);
}

/**
 * How long the drain child waits for the parent's release once it has reported ready. The child measures it from
 * its own readiness, so its startup, which has taken more than a second on a loaded Windows host, is not counted:
 * what is measured is how soon the parent's event loop runs while the child's output is pending. A synchronous
 * drain never releases the child, so its companion test always waits this long.
 */
const RELEASE_BUDGET_MS = 1_000;
/** The drain child's exit code when no release arrived within RELEASE_BUDGET_MS of its readiness. */
const RELEASE_MISSED_EXIT_CODE = 3;
/** A child start slower than the former 1 s budget, which counted the child's startup (#6076). */
const SLOW_CHILD_START_MS = 1_150;

async function assertResponsiveBinaryDrain(run: typeof runBunSubprocess, childStartDelayMs = 0): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "atomic-web-handshake-"));
	const ready = join(directory, "ready");
	const release = join(directory, "release");
	let callbackRan = false;
	// Readiness is published only after the first bytes are written. The child
	// cannot write the remaining bytes until this event-loop callback runs, and
	// exits with RELEASE_MISSED_EXIT_CODE if it has not run within
	// RELEASE_BUDGET_MS of readiness. The run's own timeout only bounds a child
	// that never gets that far. Poll frequency is not an assertion: one callback
	// after readiness suffices.
	const timer = setInterval(() => {
		if (!existsSync(ready) || callbackRan) return;
		writeFileSync(release, "");
		callbackRan = true;
	}, 1);
	try {
		const result = await run(
			bunExecutable(),
			[
				"-e",
				`
				const { existsSync, writeFileSync } = await import('node:fs');
				await Bun.sleep(${childStartDelayMs});
				await new Promise(resolve => process.stdout.write(Buffer.from([0, 1]), resolve));
				writeFileSync('ready', '');
				const readyAt = performance.now();
				let released = existsSync('release');
				while (!released && performance.now() - readyAt < ${RELEASE_BUDGET_MS}) {
					await Bun.sleep(1);
					released = existsSync('release');
				}
				if (released) {
					process.stdout.write(Buffer.from([2, 255]));
				} else {
					process.stderr.write('no release within ${RELEASE_BUDGET_MS} ms of ready');
					process.exitCode = ${RELEASE_MISSED_EXIT_CODE};
				}
			`,
			],
			{ timeoutMs: CHILD_RUN_TIMEOUT_MS, maxStdoutBytes: 1024, cwd: directory },
		);
		assert.ok(callbackRan, "parent callback must release the pending child/output");
		assert.deepEqual([...result.stdout], [0, 1, 2, 255]);
	} finally {
		clearInterval(timer);
		rmSync(directory, { recursive: true, force: true });
	}
}

/** A drain that blocks the parent's event loop until the child exits, mapping a failed exit as runBunSubprocess does. */
const synchronousDrain: typeof runBunSubprocess = async (command, args, options) => {
	const result = spawnSyncCollect([command, ...args], { cwd: options.cwd, timeout: options.timeoutMs });
	const stderr = result.stderr.toString("utf8");
	if (result.exitCode !== 0) {
		// A failed exit alone could mean failed startup. Prove the child reached
		// its output barrier and the blocked parent never acknowledged it.
		assert.ok(existsSync(join(options.cwd!, "ready")));
		assert.equal(existsSync(join(options.cwd!, "release")), false);
		throw new AsyncSubprocessError(`${command} exited with code ${result.exitCode}`, {
			code: String(result.exitCode),
			stderr,
		});
	}
	return { ...result, stderr };
};

/** The drain child gave up waiting for the parent's release. */
function missedRelease(error: AsyncSubprocessError): boolean {
	return error.code === String(RELEASE_MISSED_EXIT_CODE);
}

test("Bun subprocess execution drains binary output without blocking the event loop", async () => {
	await assertResponsiveBinaryDrain(runBunSubprocess);
});

test("binary drain responsiveness handshake rejects a synchronous drain", async () => {
	await assert.rejects(assertResponsiveBinaryDrain(synchronousDrain), missedRelease);
});

test("binary drain handshake does not count a slow child start against its budget (#6076)", async () => {
	await assertResponsiveBinaryDrain(runBunSubprocess, SLOW_CHILD_START_MS);
	await assert.rejects(assertResponsiveBinaryDrain(synchronousDrain, SLOW_CHILD_START_MS), missedRelease);
});

test("Bun subprocess execution enforces timeout and output byte caps", async () => {
	await assert.rejects(
		runBunSubprocess(bunExecutable(), ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 20, maxStdoutBytes: 1024 }),
		(error: Error & { code?: string; killed?: boolean }) => error.code === "ETIMEDOUT" && error.killed === true,
	);
	await assert.rejects(
		runBunSubprocess(bunExecutable(), ["-e", "process.stdout.write('x'.repeat(2048))"], {
			timeoutMs: CHILD_RUN_TIMEOUT_MS,
			maxStdoutBytes: 1024,
		}),
		(error: Error & { code?: string }) => error.code === "ENOBUFS",
	);
});

test("Bun subprocess execution aborts the child on caller signal with tree-kill escalation", async () => {
	const controller = new AbortController();
	const started = performance.now();
	const pending = runBunSubprocess(bunExecutable(), ["-e", "setInterval(() => {}, 1000)"], {
		timeoutMs: 10_000,
		maxStdoutBytes: 1024,
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(), 15);
	await assert.rejects(
		pending,
		(error: Error & { code?: string; killed?: boolean }) => error.code === "ABORT_ERR" && error.killed === true,
	);
	assert.ok(performance.now() - started < 5_000);
});

test("Bun subprocess execution maps spawn ENOENT and non-zero exits with stderr", async () => {
	await assert.rejects(
		runBunSubprocess("atomic-nonexistent-binary-xyz", [], { timeoutMs: 1_000, maxStdoutBytes: 1024 }),
		(error: Error & { code?: string }) => error.code === "ENOENT",
	);
	await assert.rejects(
		runBunSubprocess(bunExecutable(), ["-e", "process.stderr.write('boom'); process.exit(3)"], {
			timeoutMs: CHILD_RUN_TIMEOUT_MS,
			maxStdoutBytes: 1024,
		}),
		(error: Error & { code?: string; stderr?: string }) => error.code === "3" && error.stderr === "boom",
	);
});

test.sequential("video and YouTube command paths use asynchronous Bun subprocesses", async () => {
	if (process.platform === "win32") return;
	const bin = mkdtempSync(join(tmpdir(), "atomic-web-bin-"));
	const previousPath = process.env.PATH;
	try {
		executable(join(bin, "ffprobe"), "echo '12.5'");
		executable(join(bin, "ffmpeg"), "printf '\\377\\330\\377\\331'");
		executable(join(bin, "yt-dlp"), "echo '42'; echo 'https://stream.invalid/video'");
		process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
		assert.equal(await getLocalVideoDuration("video.mp4"), 12.5);
		const frame = await extractVideoFrame("video.mp4");
		assert.ok("data" in frame);
		if ("data" in frame) assert.equal(frame.data, Buffer.from([255, 216, 255, 217]).toString("base64"));
		assert.deepEqual(await getYouTubeStreamInfo("abcdefghijk"), {
			streamUrl: "https://stream.invalid/video",
			duration: 42,
		});
	} finally {
		process.env.PATH = previousPath;
		rmSync(bin, { recursive: true, force: true });
	}
});
