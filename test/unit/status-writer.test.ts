/**
 * Tests for the status file writer.
 *
 * Covers:
 * - resolveStatusFilePath — default vs explicit paths
 * - atomicWriteJson — temp file + rename, parent dir creation
 * - createStatusWriter — no-op when statusFile:false, subscribe/unsubscribe,
 *   flush on store update, error deduplication via warning notices,
 *   error clear on success, no flush after unsubscribe
 *
 * Uses a tmp directory under /tmp for filesystem tests; no real process.cwd().
 * cross-ref: src/extension/status-writer.ts
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	atomicWriteJson,
	createStatusWriter,
	resolveStatusFilePath,
} from "../../packages/workflows/src/extension/status-writer.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowRuntimeConfig } from "../../packages/workflows/src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<WorkflowRuntimeConfig> = {}): WorkflowRuntimeConfig {
	return {
		maxDepth: 4,
		defaultConcurrency: 4,
		persistRuns: true,
		statusFile: true,
		resumeInFlight: "ask",
		...overrides,
	};
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// resolveStatusFilePath
// ---------------------------------------------------------------------------

describe("resolveStatusFilePath", () => {
	test("uses statusFilePath from config when provided", () => {
		const cfg = makeConfig({ statusFilePath: "/explicit/path/status.json" });
		assert.equal(resolveStatusFilePath(cfg), "/explicit/path/status.json");
	});

	test("ignores projectRoot when statusFilePath is set", () => {
		const cfg = makeConfig({ statusFilePath: "/explicit/status.json" });
		assert.equal(resolveStatusFilePath(cfg, { projectRoot: "/some/root" }), "/explicit/status.json");
	});

	test("defaults to <projectRoot>/.atomic/workflows/status.json", () => {
		const cfg = makeConfig({ statusFilePath: undefined });
		const result = resolveStatusFilePath(cfg, { projectRoot: "/myproject" });
		assert.equal(result, join("/myproject", ".atomic", "workflows", "status.json"));
	});

	test("uses process.cwd() when projectRoot not provided", () => {
		const cfg = makeConfig({ statusFilePath: undefined });
		const result = resolveStatusFilePath(cfg);
		assert.equal(result, join(process.cwd(), ".atomic", "workflows", "status.json"));
	});
});

// ---------------------------------------------------------------------------
// atomicWriteJson
// ---------------------------------------------------------------------------

describe("atomicWriteJson", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "status-writer-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("writes content to target path", async () => {
		const path = join(tmpDir, "status.json");
		await atomicWriteJson(path, '{"ok":true}');
		const content = await readFile(path, "utf8");
		assert.equal(content, '{"ok":true}');
	});

	test("creates parent directories", async () => {
		const path = join(tmpDir, "nested", "deep", "status.json");
		await atomicWriteJson(path, "{}");
		const content = await readFile(path, "utf8");
		assert.equal(content, "{}");
	});

	test("leaves no tmp file on success", async () => {
		const path = join(tmpDir, "status.json");
		await atomicWriteJson(path, "{}");
		await assert.rejects(stat(`${path}.tmp`));
	});

	test("overwrites existing file", async () => {
		const path = join(tmpDir, "status.json");
		await atomicWriteJson(path, '"first"');
		await atomicWriteJson(path, '"second"');
		const content = await readFile(path, "utf8");
		assert.equal(content, '"second"');
	});

	test.each(["identical", "relative and absolute"])(
		"serializes concurrent chunked writes using %s paths (#5234)",
		async (paths) => {
			const path = join(tmpDir, "concurrent-status.json");
			const firstChunks = [
				'{"writer":1,"items":[',
				...Array.from({ length: 200 }, (_, index) => `${index > 0 ? "," : ""}"${"a".repeat(2_000)}"`),
				"]}",
			];
			const secondChunks = ['{"writer":2,"items":["final"]}'];
			const replacementPath = paths === "identical" ? path : relative(process.cwd(), path);
			await Promise.all([atomicWriteJson(path, firstChunks), atomicWriteJson(replacementPath, secondChunks)]);
			await assert.rejects(stat(`${path}.tmp`));
			const parsed = JSON.parse(await readFile(path, "utf8")) as { writer: number; items: string[] };
			assert.deepEqual(parsed, { writer: 2, items: ["final"] });
		},
	);
});

// ---------------------------------------------------------------------------
// createStatusWriter — no-op when statusFile:false
// ---------------------------------------------------------------------------

describe("createStatusWriter — statusFile:false", () => {
	test("returns a writer with no-op unsubscribe", () => {
		const s = createStore();
		const writer = createStatusWriter(s, makeConfig({ statusFile: false }));
		// Should not throw
		writer.unsubscribe();
	});

	test("does not write files when statusFile is false", async () => {
		let tmpDir: string | null = null;
		try {
			tmpDir = await mkdtemp(join(tmpdir(), "status-writer-noop-"));
			const filePath = join(tmpDir, "should-not-exist.json");
			const s = createStore();
			const writer = createStatusWriter(s, makeConfig({ statusFile: false, statusFilePath: filePath }));

			// Trigger a store update
			s.recordRunStart({
				id: "run-1",
				name: "test",
				inputs: {},
				status: "running",
				toolNodes: [],
				stages: [],
				startedAt: Date.now(),
			});

			await sleep(50);
			writer.unsubscribe();

			await assert.rejects(stat(filePath));
		} finally {
			if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// createStatusWriter — active when statusFile:true
// ---------------------------------------------------------------------------

describe("createStatusWriter — statusFile:true", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "status-writer-active-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("coalesces full status serialization off the mutation path without dropping raw fields (#5234)", async () => {
		const filePath = join(tmpDir, "coalesced.json");
		const store = createStore();
		const snapshots = vi.spyOn(store, "snapshot");
		const inspectionReads = vi.fn(() => store.inspectionSnapshot!());
		const serializations = vi.spyOn(JSON, "stringify");
		const writer = createStatusWriter(
			{ ...store, inspectionSnapshot: inspectionReads },
			makeConfig({ statusFilePath: filePath }),
		);
		try {
			for (let update = 0; update < 50; update++) {
				store.recordRunStart({
					id: `run-${update}`,
					name: "cost",
					inputs: { raw: "input" },
					status: "running",
					startedAt: 1,
					toolNodes: [],
					stages: [],
				});
			}
			assert.equal(snapshots.mock.calls.length, 0);
			assert.equal(inspectionReads.mock.calls.length, 0, "mutations only schedule serialization");
			assert.equal(serializations.mock.calls.length, 0, "mutations never serialize the status payload");
			await writer.flush();
			assert.equal(snapshots.mock.calls.length, 0);
			assert.equal(inspectionReads.mock.calls.length, 1, "one full view serves the whole burst");
			const content = JSON.parse(await readFile(filePath, "utf8"));
			assert.equal(content.runs.length, 50);
			assert.deepEqual(content.runs[0].inputs, { raw: "input" });
			serializations.mockClear();
			store.recordRunEnd("run-0", "completed", { ok: true });
			await writer.flush();
			const runSerializations = serializations.mock.calls.filter(
				([value]) => value !== null && typeof value === "object" && !Array.isArray(value) && "stages" in value,
			);
			assert.equal(runSerializations.length, 1, "unchanged frozen runs reuse their cached JSON text");
			const updated = JSON.parse(await readFile(filePath, "utf8"));
			assert.equal(updated.runs[0].status, "completed");
		} finally {
			await writer.flush();
			writer.unsubscribe();
			snapshots.mockRestore();
			serializations.mockRestore();
		}
	});

	test("preserves the final pending update when replaced (#5234)", async () => {
		const filePath = join(tmpDir, "replaced.json");
		const store = createStore();
		const writer = createStatusWriter(store, makeConfig({ statusFilePath: filePath }));
		store.recordRunStart({
			id: "run-final",
			name: "wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: 1,
		});
		await writer.flush();
		store.recordRunEnd("run-final", "completed", { done: true });
		writer.unsubscribe();
		const replacement = createStatusWriter(store, makeConfig({ statusFilePath: filePath }));
		await replacement.flush();
		replacement.unsubscribe();
		const fromReplacement = JSON.parse(await readFile(filePath, "utf8")) as {
			runs: Array<{ id: string; status: string }>;
		};
		assert.equal(fromReplacement.runs[0]?.status, "completed");
	});

	test("overwrites stale runs when replaced after the store becomes empty (#5234)", async () => {
		const filePath = join(tmpDir, "replaced-empty.json");
		const store = createStore();
		const writer = createStatusWriter(store, makeConfig({ statusFilePath: filePath }));
		store.recordRunStart({
			id: "run-stale",
			name: "wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: 1,
		});
		await writer.flush();
		store.clear();
		writer.unsubscribe();
		const replacement = createStatusWriter(store, makeConfig({ statusFilePath: filePath }));
		await replacement.flush();
		replacement.unsubscribe();
		const fromReplacement = JSON.parse(await readFile(filePath, "utf8")) as {
			runs: Array<{ id: string }>;
		};
		assert.deepEqual(fromReplacement.runs, []);
	});

	test("creates status file on store update", async () => {
		const filePath = join(tmpDir, "status.json");
		const s = createStore();
		const writer = createStatusWriter(s, makeConfig({ statusFilePath: filePath }));

		s.recordRunStart({
			id: "run-1",
			name: "wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: 1000,
		});

		await writer.flush();
		writer.unsubscribe();

		const raw = await readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as { runs: Array<{ id: string }>; version: number };
		assert.equal(parsed.runs.length, 1);
		assert.equal(parsed.runs[0]?.id, "run-1");
		assert.ok(parsed.version > 0);
	});

	test("writes after each terminal state (completed/failed/killed)", async () => {
		const filePath = join(tmpDir, "terminal.json");
		const s = createStore();
		const writer = createStatusWriter(s, makeConfig({ statusFilePath: filePath }));

		s.recordRunStart({
			id: "r-terminal",
			name: "wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});
		s.recordRunEnd("r-terminal", "completed", { x: 1 });

		await writer.flush();
		writer.unsubscribe();

		const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
			runs: Array<{ id: string; status: string }>;
		};
		assert.equal(parsed.runs[0]?.status, "completed");
	});

	test("does not flush after unsubscribe", async () => {
		const filePath = join(tmpDir, "after-unsub.json");
		const s = createStore();
		const writer = createStatusWriter(s, makeConfig({ statusFilePath: filePath }));

		s.recordRunStart({
			id: "r1",
			name: "wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});

		await writer.flush();

		// Unsubscribe BEFORE the next store update
		writer.unsubscribe();

		const contentBefore = await readFile(filePath, "utf8");

		s.recordRunEnd("r1", "failed", undefined, "oops");

		await sleep(50);

		const contentAfter = await readFile(filePath, "utf8");
		// File should not have changed since we unsubscribed
		assert.equal(contentAfter, contentBefore);
	});

	test("adds warning notice on write error, deduplicates subsequent errors", async () => {
		// Use an invalid path (file in place of directory) to force write errors.
		// Create a file where the parent directory should be.
		const blockingFile = join(tmpDir, "blocker");
		await atomicWriteJson(blockingFile, "{}"); // create as file, not dir
		const filePath = join(blockingFile, "status.json"); // parent is a file → ENOTDIR

		const s = createStore();
		const writer = createStatusWriter(s, makeConfig({ statusFilePath: filePath }));

		// First store update — triggers write failure → 1 notice added (which triggers
		// another write attempt — that also fails, but same error → no second notice).
		s.recordRunStart({
			id: "run-err",
			name: "wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});

		await writer.flush();
		writer.unsubscribe();

		const notices = s.notices();
		const writerNotices = notices.filter((n) => n.message.includes("status file write failed"));
		// Exactly one notice added (deduplication prevented more)
		assert.equal(writerNotices.length, 1);
		assert.equal(writerNotices[0]?.level, "warning");
	});

	test("clears error dedup on successful write", async () => {
		const filePath = join(tmpDir, "recover.json");
		const s = createStore();
		const writer = createStatusWriter(s, makeConfig({ statusFilePath: filePath }));

		// Write succeeds on first run start
		s.recordRunStart({
			id: "r-ok",
			name: "wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});
		await writer.flush();

		const raw = await readFile(filePath, "utf8");
		assert.ok(JSON.parse(raw));

		writer.unsubscribe();
		// No error notices expected
		assert.equal(s.notices().filter((n) => n.message.includes("status file write failed")).length, 0);
	});

	test("resolves default path relative to projectRoot", async () => {
		// Use a real nested path under tmpDir as projectRoot
		const projectRoot = join(tmpDir, "myproject");
		const expectedPath = join(projectRoot, ".atomic", "workflows", "status.json");

		const s = createStore();
		const writer = createStatusWriter(s, makeConfig({ statusFilePath: undefined }), { projectRoot });

		s.recordRunStart({
			id: "r-default",
			name: "wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});

		await writer.flush();
		writer.unsubscribe();

		const raw = await readFile(expectedPath, "utf8");
		assert.ok(JSON.parse(raw));
	});
});
