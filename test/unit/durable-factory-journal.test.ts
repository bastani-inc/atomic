import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
	getAvailableDurableBackend,
	initializeDurableBackend,
	setDurableBackend,
} from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqliteRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { StorageUnavailableError } from "../../packages/workflows/src/durable/journal/types.js";

const directories: string[] = [];
const previousPath = process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;

afterEach(async () => {
	const backend = getAvailableDurableBackend();
	if (backend instanceof JournalDurableBackend) await backend.close();
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
		assert.equal(error.path, directory);
		assert.ok(error.cause instanceof Error);
		return true;
	});
	assert.equal(getAvailableDurableBackend(), undefined);
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
	reopened.registerWorkflow({ workflowId: "reset", name: "reset", inputs: {}, status: "paused", createdAt: 1 });
	setDurableBackend(undefined);
	assert.equal(process.listenerCount("exit"), listenersBefore);
	const observer = await JournalDurableBackend.open(new SqliteRunJournal(process.env.ATOMIC_WORKFLOW_JOURNAL_PATH));
	try {
		assert.equal(observer.workflowOwnership("reset"), "available");
	} finally {
		await observer.close();
	}
});
