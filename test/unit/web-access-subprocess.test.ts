import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runBunSubprocess } from "../../packages/web-access/subprocess.ts";
import { getLocalVideoDuration, extractVideoFrame } from "../../packages/web-access/video-extract.ts";
import { getYouTubeStreamInfo } from "../../packages/web-access/youtube-extract.ts";

function executable(path: string, body: string): void {
	writeFileSync(path, `#!/usr/bin/env bun\n${body}\n`, "utf8");
	chmodSync(path, 0o755);
}

test("Bun subprocess execution drains binary output without blocking the event loop", async () => {
	let ticks = 0;
	const timer = setInterval(() => { ticks += 1; }, 1);
	try {
		const result = await runBunSubprocess(process.execPath, ["-e", "await Bun.sleep(25); process.stdout.write(Buffer.from([0,1,2,255]))"], {
			timeoutMs: 1_000,
			maxStdoutBytes: 1024,
		});
		assert.deepEqual([...result.stdout], [0, 1, 2, 255]);
		assert.ok(ticks > 5);
	} finally {
		clearInterval(timer);
	}
});

test("Bun subprocess execution enforces timeout and output byte caps", async () => {
	await assert.rejects(
		runBunSubprocess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 20, maxStdoutBytes: 1024 }),
		(error: Error & { code?: string; killed?: boolean }) => error.code === "ETIMEDOUT" && error.killed === true,
	);
	await assert.rejects(
		runBunSubprocess(process.execPath, ["-e", "process.stdout.write('x'.repeat(2048))"], { timeoutMs: 1_000, maxStdoutBytes: 1024 }),
		(error: Error & { code?: string }) => error.code === "ENOBUFS",
	);
});

test("Bun subprocess execution aborts the child on caller signal with tree-kill escalation", async () => {
	const controller = new AbortController();
	const started = performance.now();
	const pending = runBunSubprocess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
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
		runBunSubprocess(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(3)"], { timeoutMs: 1_000, maxStdoutBytes: 1024 }),
		(error: Error & { code?: string; stderr?: string }) => error.code === "3" && error.stderr === "boom",
	);
});

test.serial("video and YouTube command paths use asynchronous Bun subprocesses", async () => {
	if (process.platform === "win32") return;
	const bin = mkdtempSync(join(tmpdir(), "atomic-web-bin-"));
	const previousPath = process.env.PATH;
	try {
		executable(join(bin, "ffprobe"), "console.log('12.5')");
		executable(join(bin, "ffmpeg"), "process.stdout.write(Buffer.from([255,216,255,217]))");
		executable(join(bin, "yt-dlp"), "console.log('42'); console.log('https://stream.invalid/video')");
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
