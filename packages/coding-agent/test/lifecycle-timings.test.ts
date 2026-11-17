import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	installLifecycleTimingSink,
	installLifecycleTraceFromEnv,
	isLifecycleTimingEnabled,
	type LifecycleTimingRecord,
	type LifecycleTraceLine,
	lifecycleTraceWritten,
	markLifecycleTiming,
} from "../src/core/lifecycle-timings.ts";

describe("lifecycle timing seams", () => {
	it("does not read the monotonic clock when no diagnostic sink is installed", () => {
		const clock = vi.spyOn(process.hrtime, "bigint");
		try {
			expect(isLifecycleTimingEnabled()).toBe(false);
			markLifecycleTiming("engine-ready");
			expect(clock).not.toHaveBeenCalled();
		} finally {
			clock.mockRestore();
		}
	});

	it("records monotonic one-shot marks without writing or awaiting work", () => {
		const records: LifecycleTimingRecord[] = [];
		const marks = [101n, 202n];
		const restore = installLifecycleTimingSink(
			(record) => records.push(record),
			() => marks.shift() ?? 303n,
		);
		try {
			markLifecycleTiming("process-entry");
			markLifecycleTiming("process-entry");
			markLifecycleTiming("interactive-engine-spawn");
			expect(records).toEqual([
				{ label: "process-entry", atNs: 101n, pid: process.pid },
				{ label: "interactive-engine-spawn", atNs: 202n, pid: process.pid },
			]);
		} finally {
			restore();
		}
		expect(isLifecycleTimingEnabled()).toBe(false);
	});

	it("appends the process start and each mark to the ATOMIC_STARTUP_TRACE file in wall-clock time", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-startup-trace-"));
		const file = join(directory, "trace.jsonl");
		// The trace's clock: wall-clock time at process start plus monotonic time since. Date.now() is a separate clock
		// that drifts from it by milliseconds on Windows, so the bounds below use this one.
		const before = performance.timeOrigin + performance.now();
		const restore = installLifecycleTraceFromEnv({ ATOMIC_STARTUP_TRACE: file });
		try {
			expect(isLifecycleTimingEnabled()).toBe(true);
			// A second installer (the compiled binary's loader, then its app) keeps the first trace.
			expect(installLifecycleTraceFromEnv({ ATOMIC_STARTUP_TRACE: join(directory, "other.jsonl") })).toBeUndefined();
			markLifecycleTiming("process-entry");
			markLifecycleTiming("tui-start");
			markLifecycleTiming("tui-start");
			await lifecycleTraceWritten();
			const lines = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as LifecycleTraceLine);
			expect(lines.map((line) => line.label)).toEqual(["process-start", "process-entry", "tui-start"]);
			expect(lines.every((line) => line.pid === process.pid && line.ppid === process.ppid)).toBe(true);
			expect(lines[0]!.epochMs).toBeLessThanOrEqual(before);
			expect(lines[1]!.epochMs).toBeGreaterThanOrEqual(before);
			expect(lines[2]!.epochMs).toBeGreaterThanOrEqual(lines[1]!.epochMs);
		} finally {
			restore?.();
			rmSync(directory, { recursive: true, force: true });
		}
		expect(isLifecycleTimingEnabled()).toBe(false);
		expect(installLifecycleTraceFromEnv({})).toBeUndefined();
	});

	it("writes a mark to the trace file after the mark returns, so marking never waits for the disk", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-startup-trace-"));
		const file = join(directory, "trace.jsonl");
		const restore = installLifecycleTraceFromEnv({ ATOMIC_STARTUP_TRACE: file });
		try {
			await lifecycleTraceWritten();
			const written = readFileSync(file, "utf8");
			markLifecycleTiming("engine-ready");
			expect(readFileSync(file, "utf8")).toBe(written);
			await lifecycleTraceWritten();
			const labels = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as LifecycleTraceLine).label);
			expect(labels).toEqual(["process-start", "engine-ready"]);
		} finally {
			restore?.();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
