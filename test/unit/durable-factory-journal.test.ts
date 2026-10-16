import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vitest";
import { getDurableBackendProcessOwner } from "../../packages/workflows/src/durable/backend-process-owner.js";
import { initializeDurableBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { StorageUnavailableError } from "../../packages/workflows/src/durable/journal/types.js";

const directories: string[] = [];
const previousPath = process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;

afterEach(async () => {
	for (const entry of getDurableBackendProcessOwner().selectedBackends?.values() ?? []) {
		await entry.ready.catch(() => undefined);
		await entry.close?.();
	}
	setDurableBackend(undefined);
	if (previousPath === undefined) delete process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
	else process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = previousPath;
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("journal open failure throws typed storage error without installing a fallback", async () => {
	setDurableBackend(undefined);
	const directory = mkdtempSync(join(tmpdir(), "journal-factory-"));
	directories.push(directory);
	process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = directory;
	await assert.rejects(initializeDurableBackend(), (error: Error) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.location, directory);
		assert.ok(error.cause instanceof Error);
		return true;
	});
	assert.equal(getDurableBackendProcessOwner().selectedBackends?.size, 0);
});

test("shared journal initialization releases its exit listener on explicit close and reset", async () => {
	setDurableBackend(undefined);
	const directory = mkdtempSync(join(tmpdir(), "journal-factory-lifecycle-"));
	directories.push(directory);
	process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = join(directory, "journal.sqlite");
	const listenersBefore = process.listenerCount("exit");
	const [first, shared] = await Promise.all([initializeDurableBackend(), initializeDurableBackend()]);
	assert.ok(first instanceof JournalDurableBackend);
	assert.equal(shared, first);
	assert.equal(first.persistent, true);
	assert.equal(process.listenerCount("exit"), listenersBefore + 1);
	await first.close();
	assert.equal(process.listenerCount("exit"), listenersBefore);
	setDurableBackend(undefined);
	const reopened = await initializeDurableBackend();
	assert.ok(reopened instanceof JournalDurableBackend);
	await reopened.registerWorkflow({ workflowId: "reset", name: "reset", inputs: {}, status: "paused", createdAt: 1 });
	setDurableBackend(undefined);
	assert.equal(process.listenerCount("exit"), listenersBefore);
	const observer = await JournalDurableBackend.open(await openSqlRunJournal(process.env.ATOMIC_WORKFLOW_JOURNAL_PATH));
	try {
		assert.equal(await observer.workflowOwnership("reset"), "available");
	} finally {
		await observer.close();
	}
});

test("cached SQLite selection initializes storage only once (#3674)", async () => {
	setDurableBackend(undefined);
	const directory = mkdtempSync(join(tmpdir(), "journal-cache-"));
	directories.push(directory);
	process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = join(directory, "journal.sqlite");
	const exec = vi.spyOn(DatabaseSync.prototype, "exec");
	try {
		const first = await initializeDurableBackend();
		assert.equal(await initializeDurableBackend(), first);
		assert.equal(
			await initializeDurableBackend({ journal: { path: process.env.ATOMIC_WORKFLOW_JOURNAL_PATH } }),
			first,
		);
		assert.equal(exec.mock.calls.filter(([sql]) => sql.includes("CREATE TABLE IF NOT EXISTS wf_meta")).length, 1);
	} finally {
		exec.mockRestore();
	}
});
