import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { isResumeCatalogTimeoutError, RESUME_CATALOG_TIMEOUT_MS } from "../../packages/coding-agent/src/index.ts";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const empty = workflow({
	name: "lookup-deadline",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("step", {}, async () => "done");
		return {};
	},
});
let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "atomic-run-lookup-"));
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(directory, { recursive: true, force: true });
});

test("resuming a run from shared storage that never answers fails at the lookup deadline, typed and retryable (#4329)", async () => {
	const adapter = join(directory, "silent-journal.mjs");
	writeFileSync(
		adapter,
		"export default { atomicStorageAdapter: 1, openRunJournal() { return new Promise(() => {}); } };\n",
	);
	const runId = randomUUID();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const pending = run(empty, {}, { runId, journal: { adapter } }).then(
		() => undefined,
		(error: unknown) => error,
	);
	await vi.advanceTimersByTimeAsync(RESUME_CATALOG_TIMEOUT_MS - 1);
	assert.equal(vi.getTimerCount(), 1, "the lookup is still waiting just before its deadline");
	await vi.advanceTimersByTimeAsync(1);
	const error = await pending;
	assert.ok(isResumeCatalogTimeoutError(error), String(error));
	assert.deepEqual(
		[error.code, error.subject, error.id, error.storage, error.timeoutMs, error.retryable, error.phase],
		["catalog-timeout", "run", runId, adapter, RESUME_CATALOG_TIMEOUT_MS, true, "catalog-lookup"],
	);
});

test("a run on storage only this machine reads, or a run without an id to resume, opens its journal without a deadline (#4329)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const local = run(empty, {}, { runId: randomUUID(), journal: { path: join(directory, "journal.sqlite") } });
	const unnamed = run(empty, {}, { journal: { path: join(directory, "other.sqlite") } });
	assert.equal(vi.getTimerCount(), 0);
	vi.useRealTimers();
	const results = [await local, await unnamed];
	assert.deepEqual(
		results.map((result) => [result.status, result.error]),
		[
			["completed", undefined],
			["completed", undefined],
		],
	);
});
