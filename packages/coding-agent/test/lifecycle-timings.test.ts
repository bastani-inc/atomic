import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticWriter } from "../src/core/diagnostic-writer.ts";
import {
	installLifecycleTimingSink,
	installLifecycleTraceFromEnv,
	isLifecycleTimingEnabled,
	type LifecycleTimingRecord,
	type LifecycleTraceLine,
	lifecycleTraceWritten,
	markLifecycleTiming,
} from "../src/core/lifecycle-timings.ts";
import { EngineQuitIntent } from "../src/modes/interactive-engine/engine-quit-intent.ts";
import { serializeInteractiveEngineFrame } from "../src/modes/interactive-engine/protocol.ts";

/** Microtask turns a mark's handoff gets; acknowledging a write takes a message from the writer's thread. */
const MICROTASK_TURNS = 20;
/** A write that keeps the diagnostic writer's thread busy for many milliseconds, far longer than handling a line. */
const BUSY_WRITER_BYTES = 32 * 1024 * 1024;

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
			// The line is appended on the writer's own thread, which may land it before this thread reads the file; what
			// shows the mark did not wait for it is that the mark returned with its write still unacknowledged.
			let acknowledged = false;
			markLifecycleTiming("engine-ready");
			void lifecycleTraceWritten().then(() => {
				acknowledged = true;
			});
			for (let turn = 0; turn < MICROTASK_TURNS; turn++) await Promise.resolve();
			expect(acknowledged).toBe(false);
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

	it("an engine's trace holds its marks once it acknowledges the host's quit, before the host may end it (#5544)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-startup-trace-"));
		const file = join(directory, "trace.jsonl");
		const restore = installLifecycleTraceFromEnv({ ATOMIC_STARTUP_TRACE: file });
		const busy = new DiagnosticWriter(() => {});
		try {
			await lifecycleTraceWritten();
			// Windows ends the engine as soon as the host has its acknowledgement, without running exit handlers. Keep
			// the writer's thread busy so the mark is still waiting for it when the quit arrives.
			const busyWrite = busy.append(join(directory, "busy.bin"), "x".repeat(BUSY_WRITER_BYTES));
			markLifecycleTiming("engine-resources-ready");
			let labelsAtAck: string[] | undefined;
			const quit = new EngineQuitIntent(() => {
				labelsAtAck = readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.map((line) => (JSON.parse(line) as LifecycleTraceLine).label);
			});
			expect(quit.handleLine(serializeInteractiveEngineFrame({ type: "engine_explicit_quit" }))).toBe(true);
			expect(labelsAtAck).toEqual(["process-start", "engine-resources-ready"]);
			await busyWrite;
			await lifecycleTraceWritten();
			// Written once, not again by the writer's thread.
			expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
		} finally {
			restore?.();
			await busy.written();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
