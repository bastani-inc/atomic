import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";
import {
	getDurableBackendProcessOwner,
	releaseDurableBackendsHeldBy,
} from "../../packages/workflows/src/durable/backend-process-owner.js";
import { initializeDurableBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
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
	await reopened.commitWorkflowRegistration({
		workflowId: "reset",
		name: "reset",
		inputs: {},
		status: "paused",
		createdAt: 1,
	});
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

test("settings-selected memory journals are scoped to their owner when one is given (#3743)", async () => {
	setDurableBackend(undefined);
	process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = "";
	const settings = { workflows: { journal: { memory: true as const } } };
	const firstOwner = {};
	const secondOwner = {};
	const first = await initializeDurableBackend({ settings, holder: firstOwner });
	const second = await initializeDurableBackend({ settings, holder: secondOwner });
	assert.notEqual(first, second);
	assert.equal(await initializeDurableBackend({ settings, holder: firstOwner }), first);
	assert.equal(await initializeDurableBackend({ settings }), await initializeDurableBackend({ settings }));
});

const retainedBackendCount = (): number => getDurableBackendProcessOwner().selectedBackends?.size ?? 0;

test("releasing session-scoped memory journals returns the registry and exit listeners to baseline (#3743)", async () => {
	setDurableBackend(undefined);
	process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = "";
	const settings = { workflows: { journal: { memory: true as const } } };
	const warnings: string[] = [];
	const recordWarning = (warning: Error): void => {
		warnings.push(warning.name);
	};
	process.on("warning", recordWarning);
	const listenersBefore = process.listenerCount("exit");
	try {
		const holders = Array.from({ length: 25 }, () => ({}));
		await Promise.all(holders.map((holder) => initializeDurableBackend({ settings, holder })));
		assert.equal(retainedBackendCount(), holders.length);
		await Promise.all(holders.map((holder) => releaseDurableBackendsHeldBy(holder)));
		assert.equal(retainedBackendCount(), 0);
		assert.equal(process.listenerCount("exit"), listenersBefore);
		await nextMacrotask();
		assert.deepEqual(warnings, []);
	} finally {
		process.off("warning", recordWarning);
	}
});

test("a backend shared by several holders closes only when the last of them releases it (#3743)", async () => {
	setDurableBackend(undefined);
	const directory = mkdtempSync(join(tmpdir(), "journal-held-"));
	directories.push(directory);
	process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = join(directory, "journal.sqlite");
	const listenersBefore = process.listenerCount("exit");
	const first = {};
	const second = {};
	const shared = await initializeDurableBackend({ holder: first });
	assert.equal(await initializeDurableBackend({ holder: second }), shared);
	await releaseDurableBackendsHeldBy(first);
	assert.equal(await initializeDurableBackend({ holder: second }), shared);
	assert.equal(retainedBackendCount(), 1);
	assert.equal(process.listenerCount("exit"), listenersBefore + 1);
	await releaseDurableBackendsHeldBy(second);
	assert.equal(retainedBackendCount(), 0);
	assert.equal(process.listenerCount("exit"), listenersBefore);
	assert.notEqual(await initializeDurableBackend({ holder: first }), shared);
});

test("a backend a caller selected without a holder outlives the release of its holders (#3743)", async () => {
	setDurableBackend(undefined);
	const directory = mkdtempSync(join(tmpdir(), "journal-pinned-"));
	directories.push(directory);
	process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = join(directory, "journal.sqlite");
	const listenersBefore = process.listenerCount("exit");
	const holder = {};
	const shared = await initializeDurableBackend();
	assert.equal(await initializeDurableBackend({ holder }), shared);
	await releaseDurableBackendsHeldBy(holder);
	assert.equal(await initializeDurableBackend(), shared);
	assert.equal(retainedBackendCount(), 1);
	assert.equal(process.listenerCount("exit"), listenersBefore + 1);
});

test("releasing a holder never closes a journal the caller supplied (#3743)", async () => {
	setDurableBackend(undefined);
	const journal = new MemoryRunJournal();
	const holder = {};
	const backend = await initializeDurableBackend({ journal, holder });
	assert.equal(retainedBackendCount(), 1);
	await releaseDurableBackendsHeldBy(holder);
	assert.equal(retainedBackendCount(), 0);
	assert.deepEqual(await journal.listRuns(), []);
	assert.notEqual(await initializeDurableBackend({ journal, holder }), backend);
});

test("a failed open after its holder released does not drop a newer session's backend (#3743)", async () => {
	setDurableBackend(undefined);
	const directory = mkdtempSync(join(tmpdir(), "journal-failed-open-"));
	directories.push(directory);
	process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = join(directory, "journal.sqlite");
	const open = JournalDurableBackend.open.bind(JournalDurableBackend);
	const firstOpen = Promise.withResolvers<JournalDurableBackend>();
	const spy = vi.spyOn(JournalDurableBackend, "open").mockImplementationOnce((journal) =>
		firstOpen.promise.catch(async (error: Error) => {
			await journal.close();
			throw error;
		}),
	);
	spy.mockImplementation(open);
	const released = {};
	const current = {};

	const failing = initializeDurableBackend({ holder: released });
	const releasing = releaseDurableBackendsHeldBy(released);
	const replacement = await initializeDurableBackend({ holder: current });
	firstOpen.reject(new Error("open failed"));
	await assert.rejects(failing, /open failed/);
	await releasing;

	assert.equal(await initializeDurableBackend({ holder: current }), replacement);
	spy.mockRestore();
});
