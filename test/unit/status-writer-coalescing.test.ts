import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test, vi } from "vitest";
import { ENGINE_SHUTDOWN_GRACE_MS } from "../../packages/coding-agent/src/modes/rpc/rpc-client-process.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeRun, makeStage } from "./overlay-graph-helpers.js";

let writeFileHook: ((path: string, content: string | Iterable<string>) => Promise<void>) | undefined;
let renameHook: ((oldPath: string, newPath: string) => Promise<void>) | undefined;
let unlinkHook: ((path: string) => Promise<void>) | undefined;

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
		unlink: async (path: string) => {
			await unlinkHook?.(path);
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

test("serializes overlapping status writes across two reloaded module instances (#5234)", async () => {
	vi.resetModules();
	const firstModule = await import("../../packages/workflows/src/extension/status-writer.js");
	vi.resetModules();
	const secondModule = await import("../../packages/workflows/src/extension/status-writer.js");
	assert.notEqual(firstModule.createStatusWriter, secondModule.createStatusWriter);

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
		statusFilePath: "status-reload.json",
	};
	const oldWriter = firstModule.createStatusWriter(store, config);
	let newWriter: ReturnType<typeof secondModule.createStatusWriter> | undefined;
	try {
		await firstWriteStarted;
		newWriter = secondModule.createStatusWriter(store, {
			...config,
			statusFilePath: "./status-reload.json",
		});
		store.recordRunEnd("live", "completed", { ok: true });
		for (let turn = 0; turn < 5; turn++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		assert.equal(maxActiveAtomicWrites, 1);
		releaseFirstWrite?.();
		await oldWriter.flush();
		oldWriter.unsubscribe();
		await newWriter.flush();
		assert.equal(maxActiveAtomicWrites, 1);
		assert.deepEqual(
			store.notices().filter((notice) => notice.message.includes("status file write failed")),
			[],
		);
		const published = JSON.parse(publishedByPath.get(resolve("status-reload.json")) ?? "{}") as {
			runs: Array<{ id: string; status: string }>;
		};
		assert.equal(published.runs[0]?.status, "completed");
	} finally {
		releaseFirstWrite?.();
		oldWriter.unsubscribe();
		newWriter?.unsubscribe();
		writeFileHook = undefined;
		renameHook = undefined;
		unlinkHook = undefined;
	}
});

test("waits out a reader holding status.json across several EPERM retries, cleans up tmp, and rewrites on the next drain without a failure notice (#5234, #5322)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.resetModules();
	const { createStatusWriter } = await import("../../packages/workflows/src/extension/status-writer.js");
	const store = createStore();
	store.recordRunStart({ ...makeRun([makeStage("stage")]), id: "live", status: "running" });
	const stagedByPath = new Map<string, string>();
	const publishedByPath = new Map<string, string>();
	let failRename = true;
	let renameAttempts = 0;
	writeFileHook = async (path, content) => {
		const text = typeof content === "string" ? content : Array.from(content).join("");
		stagedByPath.set(path, text);
	};
	renameHook = async (oldPath, newPath) => {
		renameAttempts++;
		if (failRename) {
			throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
		}
		const staged = stagedByPath.get(oldPath);
		assert.notEqual(staged, undefined);
		stagedByPath.delete(oldPath);
		publishedByPath.set(newPath, staged!);
	};
	unlinkHook = async (path) => {
		stagedByPath.delete(path);
	};
	const targetPath = resolve("status-eperm-drain.json");
	const tmpPath = `${targetPath}.tmp`;
	const writer = createStatusWriter(store, {
		maxDepth: 4,
		defaultConcurrency: 4,
		persistRuns: true,
		resumeInFlight: "ask",
		statusFile: true,
		statusFilePath: "status-eperm-drain.json",
	});
	try {
		await vi.advanceTimersByTimeAsync(200);
		assert.equal(renameAttempts, 6);
		assert.equal(stagedByPath.has(tmpPath), false);
		assert.equal(store.notices().filter((notice) => notice.message.includes("status file write failed")).length, 0);

		await vi.advanceTimersByTimeAsync(450);
		assert.equal(renameAttempts, 12);
		assert.equal(stagedByPath.has(tmpPath), false);
		assert.equal(store.notices().filter((notice) => notice.message.includes("status file write failed")).length, 0);

		await vi.advanceTimersByTimeAsync(1_200);
		assert.equal(renameAttempts, 18);
		assert.equal(stagedByPath.has(tmpPath), false);
		assert.equal(store.notices().filter((notice) => notice.message.includes("status file write failed")).length, 0);
		assert.equal(publishedByPath.has(targetPath), false);

		failRename = false;
		await vi.advanceTimersByTimeAsync(4_100);
		assert.equal(stagedByPath.has(tmpPath), false);
		assert.equal(store.notices().filter((notice) => notice.message.includes("status file write failed")).length, 0);
		const published = JSON.parse(publishedByPath.get(targetPath) ?? "{}") as {
			runs: Array<{ id: string; status: string }>;
			notices: Array<{ message: string }>;
		};
		assert.equal(published.runs[0]?.id, "live");
		assert.equal(published.runs[0]?.status, "running");
		assert.deepEqual(published.notices, []);

		failRename = true;
		store.recordRunEnd("live", "completed", { ok: true });
		await vi.advanceTimersByTimeAsync(900);
		assert.equal(stagedByPath.has(tmpPath), false);
		assert.equal(store.notices().filter((notice) => notice.message.includes("status file write failed")).length, 0);

		failRename = false;
		await vi.advanceTimersByTimeAsync(1_200);
		assert.equal(store.notices().filter((notice) => notice.message.includes("status file write failed")).length, 0);
		const republished = JSON.parse(publishedByPath.get(targetPath) ?? "{}") as {
			runs: Array<{ id: string; status: string }>;
			notices: Array<{ message: string }>;
		};
		assert.equal(republished.runs[0]?.status, "completed");
		assert.deepEqual(republished.notices, []);
	} finally {
		writer.unsubscribe();
		await vi.runAllTimersAsync();
		writeFileHook = undefined;
		renameHook = undefined;
		unlinkHook = undefined;
		vi.useRealTimers();
	}
});

test.each(["EPERM", "EACCES", "EBUSY"])(
	"keeps #5234 backoff on persistent %s rename failures, records a warning notice only after backoff exhaustion, and recovers on store change (#5322)",
	async (code) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		vi.resetModules();
		const { createStatusWriter } = await import("../../packages/workflows/src/extension/status-writer.js");
		const store = createStore();
		store.recordRunStart({ ...makeRun([makeStage("stage")]), id: "live", status: "running" });
		const stagedByPath = new Map<string, string>();
		const publishedByPath = new Map<string, string>();
		let failRename = true;
		let writeAttempts = 0;
		writeFileHook = async (path, content) => {
			writeAttempts++;
			const text = typeof content === "string" ? content : Array.from(content).join("");
			stagedByPath.set(path, text);
		};
		renameHook = async (oldPath, newPath) => {
			if (failRename) {
				throw Object.assign(new Error(`${code}: rename refused`), { code });
			}
			const staged = stagedByPath.get(oldPath);
			assert.notEqual(staged, undefined);
			stagedByPath.delete(oldPath);
			publishedByPath.set(newPath, staged!);
		};
		unlinkHook = async (path) => {
			stagedByPath.delete(path);
		};
		const statusFileName = `status-persistent-${code.toLowerCase()}.json`;
		const targetPath = resolve(statusFileName);
		const writer = createStatusWriter(store, {
			maxDepth: 4,
			defaultConcurrency: 4,
			persistRuns: true,
			resumeInFlight: "ask",
			statusFile: true,
			statusFilePath: statusFileName,
		});
		try {
			await vi.advanceTimersByTimeAsync(160);
			assert.equal(writeAttempts, 1);
			assert.equal(store.notices().length, 0);

			await vi.advanceTimersByTimeAsync(250 + 160);
			assert.equal(writeAttempts, 2);
			assert.equal(store.notices().length, 0);

			await vi.advanceTimersByTimeAsync(1_000 + 160);
			assert.equal(writeAttempts, 3);
			assert.equal(store.notices().length, 0);

			await vi.advanceTimersByTimeAsync(4_000 + 160);
			assert.equal(writeAttempts, 4);
			assert.equal(store.notices().length, 0);

			await vi.advanceTimersByTimeAsync(16_000 + 160);
			assert.equal(writeAttempts, 5);
			const notices = store.notices().filter((notice) => notice.message.includes("status file write failed"));
			assert.equal(notices.length, 1);
			assert.equal(notices[0]?.level, "warning");
			assert.match(notices[0]?.message ?? "", new RegExp(code));

			await vi.advanceTimersByTimeAsync(60_000);
			assert.equal(writeAttempts, 5, "stops retrying after the 4 backoff delays");
			assert.equal(store.notices().length, 1);

			failRename = false;
			store.recordRunEnd("live", "completed", { ok: true });
			await vi.advanceTimersByTimeAsync(260);
			assert.equal(writeAttempts, 6);
			const published = JSON.parse(publishedByPath.get(targetPath) ?? "{}") as {
				runs: Array<{ id: string; status: string }>;
			};
			assert.equal(published.runs[0]?.status, "completed");
		} finally {
			writer.unsubscribe();
			await vi.runAllTimersAsync();
			writeFileHook = undefined;
			renameHook = undefined;
			unlinkHook = undefined;
			vi.useRealTimers();
		}
	},
);

test("a store change after a reader releases status.json republishes within one write interval (#5322)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.resetModules();
	const { createStatusWriter } = await import("../../packages/workflows/src/extension/status-writer.js");
	const store = createStore();
	store.recordRunStart({ ...makeRun([makeStage("stage")]), id: "live", status: "running" });
	const stagedByPath = new Map<string, string>();
	const publishedByPath = new Map<string, string>();
	let failRename = true;
	let writeAttempts = 0;
	writeFileHook = async (path, content) => {
		writeAttempts++;
		const text = typeof content === "string" ? content : Array.from(content).join("");
		stagedByPath.set(path, text);
	};
	renameHook = async (oldPath, newPath) => {
		if (failRename) {
			throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
		}
		const staged = stagedByPath.get(oldPath);
		assert.notEqual(staged, undefined);
		stagedByPath.delete(oldPath);
		publishedByPath.set(newPath, staged!);
	};
	unlinkHook = async (path) => {
		stagedByPath.delete(path);
	};
	const targetPath = resolve("status-store-change-reset.json");
	const writer = createStatusWriter(store, {
		maxDepth: 4,
		defaultConcurrency: 4,
		persistRuns: true,
		resumeInFlight: "ask",
		statusFile: true,
		statusFilePath: "status-store-change-reset.json",
	});
	try {
		for (let step = 1; step <= 40; step++) {
			store.recordRunSummary!("live", `step-${step}`, step);
			await vi.advanceTimersByTimeAsync(300);
		}
		assert.ok(writeAttempts >= 25, `expected store changes to keep waking retries during hold, got ${writeAttempts}`);
		assert.equal(store.notices().length, 0);

		failRename = false;
		store.recordRunSummary!("live", "after-release", 41);
		await vi.advanceTimersByTimeAsync(500);
		assert.equal(store.notices().length, 0);
		const published = JSON.parse(publishedByPath.get(targetPath) ?? "{}") as {
			runs: Array<{ id: string; summary?: string }>;
		};
		assert.equal(published.runs[0]?.summary, "after-release");
	} finally {
		writer.unsubscribe();
		await vi.runAllTimersAsync();
		writeFileHook = undefined;
		renameHook = undefined;
		unlinkHook = undefined;
		vi.useRealTimers();
	}
});

test("a persistent reader hold under ongoing store changes records exactly one warning after the hold budget (#5322)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.resetModules();
	const { createStatusWriter } = await import("../../packages/workflows/src/extension/status-writer.js");
	const store = createStore();
	store.recordRunStart({ ...makeRun([makeStage("stage")]), id: "live", status: "running" });
	const stagedByPath = new Map<string, string>();
	let writeAttempts = 0;
	writeFileHook = async (path, content) => {
		writeAttempts++;
		const text = typeof content === "string" ? content : Array.from(content).join("");
		stagedByPath.set(path, text);
	};
	renameHook = async () => {
		throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
	};
	unlinkHook = async (path) => {
		stagedByPath.delete(path);
	};
	const writer = createStatusWriter(store, {
		maxDepth: 4,
		defaultConcurrency: 4,
		persistRuns: true,
		resumeInFlight: "ask",
		statusFile: true,
		statusFilePath: "status-active-persistent-hold.json",
	});
	try {
		for (let step = 1; step <= 70; step++) {
			store.recordRunSummary!("live", `step-${step}`, step);
			await vi.advanceTimersByTimeAsync(300);
		}
		assert.equal(store.notices().length, 0);

		for (let step = 71; step <= 75; step++) {
			store.recordRunSummary!("live", `step-${step}`, step);
			await vi.advanceTimersByTimeAsync(300);
		}
		const noticesAtBudget = store.notices().filter((notice) => notice.message.includes("status file write failed"));
		assert.equal(noticesAtBudget.length, 1);
		assert.equal(noticesAtBudget[0]?.level, "warning");
		assert.match(noticesAtBudget[0]?.message ?? "", /EPERM/);

		for (let step = 76; step <= 200; step++) {
			store.recordRunSummary!("live", `step-${step}`, step);
			await vi.advanceTimersByTimeAsync(300);
		}
		assert.equal(store.notices().filter((notice) => notice.message.includes("status file write failed")).length, 1);
		assert.ok(writeAttempts > 40, `expected > 40 write attempts under ongoing changes, got ${writeAttempts}`);
	} finally {
		writer.unsubscribe();
		await vi.runAllTimersAsync();
		writeFileHook = undefined;
		renameHook = undefined;
		unlinkHook = undefined;
		vi.useRealTimers();
	}
});

test("flush waits out a transient reader hold across several retries without recording a failure notice (#5322)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.resetModules();
	const { createStatusWriter } = await import("../../packages/workflows/src/extension/status-writer.js");
	const store = createStore();
	store.recordRunStart({ ...makeRun([makeStage("stage")]), id: "live", status: "running" });
	const stagedByPath = new Map<string, string>();
	const publishedByPath = new Map<string, string>();
	let renameAttempts = 0;
	writeFileHook = async (path, content) => {
		const text = typeof content === "string" ? content : Array.from(content).join("");
		stagedByPath.set(path, text);
	};
	renameHook = async (oldPath, newPath) => {
		renameAttempts++;
		if (renameAttempts <= 14) {
			throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
		}
		const staged = stagedByPath.get(oldPath);
		assert.notEqual(staged, undefined);
		stagedByPath.delete(oldPath);
		publishedByPath.set(newPath, staged!);
	};
	unlinkHook = async (path) => {
		stagedByPath.delete(path);
	};
	const targetPath = resolve("status-flush-reader-hold.json");
	const writer = createStatusWriter(store, {
		maxDepth: 4,
		defaultConcurrency: 4,
		persistRuns: true,
		resumeInFlight: "ask",
		statusFile: true,
		statusFilePath: "status-flush-reader-hold.json",
	});
	try {
		const started = Date.now();
		let settledAt: number | null = null;
		const flushing = writer.flush().then(() => {
			settledAt = Date.now() - started;
		});
		await vi.advanceTimersByTimeAsync(900);
		await flushing;
		assert.notEqual(settledAt, null);
		assert.ok(settledAt! < 1_000, `expected flush to settle within 1s budget, got ${settledAt}ms`);
		assert.ok(settledAt! < ENGINE_SHUTDOWN_GRACE_MS);
		assert.equal(renameAttempts, 15);
		assert.equal(store.notices().filter((notice) => notice.message.includes("status file write failed")).length, 0);
		const published = JSON.parse(publishedByPath.get(targetPath) ?? "{}") as {
			runs: Array<{ id: string; status: string }>;
		};
		assert.equal(published.runs[0]?.id, "live");
		assert.equal(published.runs[0]?.status, "running");
	} finally {
		writer.unsubscribe();
		await vi.runAllTimersAsync();
		writeFileHook = undefined;
		renameHook = undefined;
		unlinkHook = undefined;
		vi.useRealTimers();
	}
});

test("a shutdown flush under a persistent reader hold returns within the engine shutdown grace and records one warning (#5322)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.resetModules();
	const { createStatusWriter } = await import("../../packages/workflows/src/extension/status-writer.js");
	const store = createStore();
	store.recordRunStart({ ...makeRun([makeStage("stage")]), id: "live", status: "running" });
	const stagedByPath = new Map<string, string>();
	let writeAttempts = 0;
	writeFileHook = async (path, content) => {
		writeAttempts++;
		const text = typeof content === "string" ? content : Array.from(content).join("");
		stagedByPath.set(path, text);
	};
	renameHook = async () => {
		throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
	};
	unlinkHook = async (path) => {
		stagedByPath.delete(path);
	};
	const writer = createStatusWriter(store, {
		maxDepth: 4,
		defaultConcurrency: 4,
		persistRuns: true,
		resumeInFlight: "ask",
		statusFile: true,
		statusFilePath: "status-flush-persistent-hold.json",
	});
	try {
		const started = Date.now();
		let settledAt: number | null = null;
		const flushing = writer.flush().then(() => {
			settledAt = Date.now() - started;
		});
		await vi.advanceTimersByTimeAsync(1_500);
		assert.notEqual(settledAt, null, "flush must settle within the 1s hold budget");
		await flushing;
		assert.ok(settledAt! < ENGINE_SHUTDOWN_GRACE_MS, `flush took ${settledAt}ms >= ${ENGINE_SHUTDOWN_GRACE_MS}ms`);
		const notices = store.notices().filter((notice) => notice.message.includes("status file write failed"));
		assert.equal(notices.length, 1);
		assert.equal(notices[0]?.level, "warning");
		assert.match(notices[0]?.message ?? "", /EPERM/);

		const attemptsAtFlushEnd = writeAttempts;
		writer.unsubscribe();
		await vi.advanceTimersByTimeAsync(60_000);
		assert.equal(writeAttempts, attemptsAtFlushEnd);
	} finally {
		writer.unsubscribe();
		await vi.runAllTimersAsync();
		writeFileHook = undefined;
		renameHook = undefined;
		unlinkHook = undefined;
		vi.useRealTimers();
	}
});

test("unsubscribe during a flush hold sleep settles flush promptly without recording a warning (#5322)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.resetModules();
	const { createStatusWriter } = await import("../../packages/workflows/src/extension/status-writer.js");
	const store = createStore();
	store.recordRunStart({ ...makeRun([makeStage("stage")]), id: "live", status: "running" });
	writeFileHook = async () => undefined;
	renameHook = async () => {
		throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
	};
	unlinkHook = async () => undefined;
	const writer = createStatusWriter(store, {
		maxDepth: 4,
		defaultConcurrency: 4,
		persistRuns: true,
		resumeInFlight: "ask",
		statusFile: true,
		statusFilePath: "status-flush-unsub.json",
	});
	try {
		let settled = false;
		const flushing = writer.flush().then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(200);
		assert.equal(settled, false);
		writer.unsubscribe();
		await flushing;
		assert.equal(settled, true);
		assert.equal(store.notices().length, 0);
	} finally {
		writer.unsubscribe();
		await vi.runAllTimersAsync();
		writeFileHook = undefined;
		renameHook = undefined;
		unlinkHook = undefined;
		vi.useRealTimers();
	}
});

test("retries persistent write failures with growing delays, stops after four backoff attempts, and resets on store change (#5234)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.resetModules();
	const { createStatusWriter } = await import("../../packages/workflows/src/extension/status-writer.js");
	const store = createStore();
	store.recordRunStart({ ...makeRun([makeStage("stage")]), id: "live", status: "running" });
	const stagedByPath = new Map<string, string>();
	const publishedByPath = new Map<string, string>();
	let failRename = true;
	let writeAttempts = 0;
	writeFileHook = async (path, content) => {
		writeAttempts++;
		const text = typeof content === "string" ? content : Array.from(content).join("");
		stagedByPath.set(path, text);
	};
	renameHook = async (oldPath, newPath) => {
		if (failRename) {
			throw Object.assign(new Error("EISDIR: illegal operation on a directory, rename"), { code: "EISDIR" });
		}
		const staged = stagedByPath.get(oldPath);
		assert.notEqual(staged, undefined);
		stagedByPath.delete(oldPath);
		publishedByPath.set(newPath, staged!);
	};
	unlinkHook = async (path) => {
		stagedByPath.delete(path);
	};
	const targetPath = resolve("status-persistent-backoff.json");
	const writer = createStatusWriter(store, {
		maxDepth: 4,
		defaultConcurrency: 4,
		persistRuns: true,
		resumeInFlight: "ask",
		statusFile: true,
		statusFilePath: "status-persistent-backoff.json",
	});
	try {
		await vi.advanceTimersByTimeAsync(10);
		assert.equal(writeAttempts, 1);

		await vi.advanceTimersByTimeAsync(250);
		assert.equal(writeAttempts, 2);

		await vi.advanceTimersByTimeAsync(250);
		assert.equal(writeAttempts, 3);

		await vi.advanceTimersByTimeAsync(1_000);
		assert.equal(writeAttempts, 4);

		await vi.advanceTimersByTimeAsync(4_000);
		assert.equal(writeAttempts, 5);

		await vi.advanceTimersByTimeAsync(16_000);
		assert.equal(writeAttempts, 6);

		await vi.advanceTimersByTimeAsync(60_000);
		assert.equal(writeAttempts, 6, "stops retrying after the 4 backoff delays");

		failRename = false;
		store.recordRunEnd("live", "completed", { ok: true });
		await vi.advanceTimersByTimeAsync(260);
		assert.equal(writeAttempts, 7);
		const published = JSON.parse(publishedByPath.get(targetPath) ?? "{}") as {
			runs: Array<{ id: string; status: string }>;
		};
		assert.equal(published.runs[0]?.status, "completed");
	} finally {
		writer.unsubscribe();
		await vi.runAllTimersAsync();
		writeFileHook = undefined;
		renameHook = undefined;
		unlinkHook = undefined;
		vi.useRealTimers();
	}
});

test("runs a status write queued behind a failed write for the same path (#5234)", async () => {
	vi.resetModules();
	const { atomicWriteJson } = await import("../../packages/workflows/src/extension/status-writer.js");
	let writeCalls = 0;
	const stagedByPath = new Map<string, string>();
	const publishedByPath = new Map<string, string>();
	writeFileHook = async (path, content) => {
		writeCalls++;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		if (writeCalls === 1) {
			throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
		}
		const text = typeof content === "string" ? content : Array.from(content).join("");
		stagedByPath.set(path, text);
	};
	renameHook = async (oldPath, newPath) => {
		const staged = stagedByPath.get(oldPath);
		assert.notEqual(staged, undefined);
		stagedByPath.delete(oldPath);
		publishedByPath.set(newPath, staged!);
	};
	unlinkHook = async (path) => {
		stagedByPath.delete(path);
	};
	try {
		const first = atomicWriteJson("queue-failure/status.json", '{"writer":1}');
		const second = atomicWriteJson("queue-failure/status.json", '{"writer":2}');
		await assert.rejects(first, /EIO/);
		await second;
		assert.equal(writeCalls, 2);
		assert.equal(publishedByPath.get(resolve("queue-failure/status.json")), '{"writer":2}');
	} finally {
		writeFileHook = undefined;
		renameHook = undefined;
		unlinkHook = undefined;
	}
});
