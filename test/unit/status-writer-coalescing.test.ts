import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test, vi } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeRun, makeStage } from "./overlay-graph-helpers.js";

let writeFileHook: ((path: string, content: string | Iterable<string>) => Promise<void>) | undefined;
let renameHook: ((oldPath: string, newPath: string) => Promise<void>) | undefined;

vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...fs,
		mkdir: async () => undefined,
		writeFile: async (path: string, content: string | Iterable<string>) => {
			await writeFileHook?.(path, content);
		},
		rename: async (oldPath: string, newPath: string) => {
			await renameHook?.(oldPath, newPath);
		},
	};
});

test("throttles 5ms-spaced status updates independently of disk latency (#5234)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const { createStatusWriter } = await import("../../packages/workflows/src/extension/status-writer.js");
	const store = createStore();
	store.recordRunStart({ ...makeRun([makeStage("stage")]), id: "live" });
	const reads = vi.spyOn(store, "inspectionSnapshot");
	const writer = createStatusWriter(store, {
		maxDepth: 4,
		defaultConcurrency: 4,
		persistRuns: true,
		resumeInFlight: "ask",
		statusFile: true,
		statusFilePath: "status.json",
	});
	try {
		await vi.runAllTimersAsync();
		await writer.flush();
		reads.mockClear();
		for (let step = 0; step < 60; step++) {
			store.recordRunSummary!("live", `step-${step}`, step);
			await vi.advanceTimersByTimeAsync(5);
		}
		assert.equal(reads.mock.calls.length, 1, "300ms of updates produces one scheduled status read");
		const flushing = writer.flush();
		await vi.runAllTimersAsync();
		await flushing;
		assert.equal(reads.mock.calls.length, 2, "flush reads the final pending update once");
	} finally {
		writer.unsubscribe();
		await vi.runAllTimersAsync();
		reads.mockRestore();
		vi.useRealTimers();
	}
});

test("serializes overlapping status writes when a writer is replaced mid-write (#5234)", async () => {
	vi.resetModules();
	const { createStatusWriter } = await import("../../packages/workflows/src/extension/status-writer.js");
	const store = createStore();
	store.recordRunStart({ ...makeRun([makeStage("stage")]), id: "live", status: "running" });
	let activeAtomicWrites = 0;
	let maxActiveAtomicWrites = 0;
	let writeCount = 0;
	const stagedByPath = new Map<string, string>();
	const publishedByPath = new Map<string, string>();
	let notifyFirstWriteStarted: (() => void) | undefined;
	const firstWriteStarted = new Promise<void>((resolve) => {
		notifyFirstWriteStarted = resolve;
	});
	let releaseFirstWrite: (() => void) | undefined;
	const firstWriteGate = new Promise<void>((resolve) => {
		releaseFirstWrite = resolve;
	});
	writeFileHook = async (path, content) => {
		activeAtomicWrites++;
		maxActiveAtomicWrites = Math.max(maxActiveAtomicWrites, activeAtomicWrites);
		const text = typeof content === "string" ? content : Array.from(content).join("");
		stagedByPath.set(path, text);
		writeCount++;
		if (writeCount === 1) {
			notifyFirstWriteStarted?.();
			await firstWriteGate;
		}
	};
	renameHook = async (oldPath, newPath) => {
		const staged = stagedByPath.get(oldPath);
		if (staged === undefined) {
			throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`), {
				code: "ENOENT",
			});
		}
		stagedByPath.delete(oldPath);
		publishedByPath.set(newPath, staged);
		activeAtomicWrites--;
	};
	const config = {
		maxDepth: 4,
		defaultConcurrency: 4,
		persistRuns: true,
		resumeInFlight: "ask" as const,
		statusFile: true,
		statusFilePath: "status-overlap.json",
	};
	const writer = createStatusWriter(store, config);
	let replacement: ReturnType<typeof createStatusWriter> | undefined;
	try {
		await firstWriteStarted;
		store.recordRunEnd("live", "completed", { ok: true });
		writer.unsubscribe();
		replacement = createStatusWriter(store, config);
		const flushing = replacement.flush();
		for (let turn = 0; turn < 5; turn++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		releaseFirstWrite?.();
		await flushing;
		assert.equal(maxActiveAtomicWrites, 1);
		assert.deepEqual(
			store.notices().filter((notice) => notice.message.includes("status file write failed")),
			[],
		);
		const published = JSON.parse(publishedByPath.get(resolve("status-overlap.json")) ?? "{}") as {
			runs: Array<{ id: string; status: string }>;
		};
		assert.equal(published.runs[0]?.status, "completed");
	} finally {
		releaseFirstWrite?.();
		writer.unsubscribe();
		replacement?.unsubscribe();
		writeFileHook = undefined;
		renameHook = undefined;
	}
});
