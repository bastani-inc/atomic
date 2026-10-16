import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { RunOpts } from "../../packages/workflows/src/authoring.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { type RunJournalSettings, resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlRunJournal, SqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { JournalConfigurationError, type RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

let root: string;
const opened: RunJournal[] = [];
const conflicting: RunJournalSettings = { workflows: { journal: { path: "settings.sqlite", memory: true } } };

beforeEach(() => {
	root = makeTempDirectory("journal-resolution-");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", "");
});
afterEach(async () => {
	for (const journal of opened.splice(0)) await journal.close();
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

async function resolve(
	options: { journal?: RunOpts["journal"]; settings?: RunJournalSettings } = {},
): Promise<RunJournal> {
	const journal = await resolveRunJournal(options);
	opened.push(journal);
	return journal;
}

test("explicit journal path wins over environment and conflicting settings without normalization", async () => {
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", join(root, "environment.sqlite"));
	const path = `${root}/nested/../ explicit.sqlite `;
	const journal = await resolve({ journal: { path }, settings: conflicting });
	assert.ok(journal instanceof SqlRunJournal);
	assert.equal(journal.path, path);
});

test("explicit memory and journal instances are used instead of environment and settings", async () => {
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", join(root, "environment.sqlite"));
	assert.ok((await resolve({ journal: { memory: true }, settings: conflicting })) instanceof MemoryRunJournal);
	const instance = new MemoryRunJournal();
	assert.equal(await resolve({ journal: instance, settings: conflicting }), instance);
	const sqlite = await openSqlRunJournal(join(root, "instance.sqlite"));
	assert.equal(await resolve({ journal: sqlite, settings: conflicting }), sqlite);
});

test("explicit caller-owned connection wins and stays open", async () => {
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", join(root, "environment.sqlite"));
	const database = new DatabaseSync(join(root, "caller.sqlite"));
	try {
		const journal = await resolve({ journal: { database }, settings: conflicting });
		assert.ok(journal instanceof SqlRunJournal);
		await journal.close();
		assert.equal(database.prepare("SELECT schema_version FROM wf_meta").get()?.schema_version, 1);
	} finally {
		database.close();
	}
});

test("nonempty environment overrides settings including a conflicting block", async () => {
	const path = join(root, " environment.sqlite ");
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", path);
	const journal = await resolve({ settings: conflicting });
	assert.ok(journal instanceof SqlRunJournal);
	assert.equal(journal.path, path);
});

test("settings path resolves relative to Atomic home and overrides the default", async () => {
	const journal = await resolve({
		settings: { workflows: { journal: { path: "nested/settings.sqlite", memory: false } } },
	});
	assert.ok(journal instanceof SqlRunJournal);
	assert.equal(journal.path, join(dirname(getAgentDir()), "nested/settings.sqlite"));
});

test("absolute settings paths are preserved", async () => {
	const path = join(root, "absolute.sqlite");
	const journal = await resolve({ settings: { workflows: { journal: { path } } } });
	assert.ok(journal instanceof SqlRunJournal);
	assert.equal(journal.path, path);
});

test("settings memory true selects memory even when path is empty", async () => {
	for (const path of [undefined, ""]) {
		assert.ok(
			(await resolve({ settings: { workflows: { journal: { path, memory: true } } } })) instanceof MemoryRunJournal,
		);
	}
});

test("absent and empty settings and memory false use the persistent default", async () => {
	for (const settings of [
		undefined,
		{},
		{ workflows: [] },
		{ workflows: { journal: {} } },
		{ workflows: { journal: { path: "", memory: false } } },
	]) {
		const journal = await resolve({ settings });
		assert.ok(journal instanceof SqlRunJournal);
		assert.equal(journal.path, join(dirname(getAgentDir()), "workflows", "journal.sqlite"));
	}
});

test("selected settings with nonempty path and memory true fail with exact typed fields", async () => {
	await assert.rejects(
		async () => await resolve({ settings: conflicting }),
		(error: Error) => {
			assert.ok(error instanceof JournalConfigurationError);
			assert.equal(error.source, "settings");
			assert.equal(error.setting, "workflows.journal");
			assert.equal(error.reason, "path-and-memory");
			return true;
		},
	);
});
