import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { RunOpts } from "../../packages/workflows/src/authoring.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { type RunJournalSettings, resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqliteRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
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

function resolve(options: { journal?: RunOpts["journal"]; settings?: RunJournalSettings } = {}): RunJournal {
	const journal = resolveRunJournal(options);
	opened.push(journal);
	return journal;
}

test("explicit journal path wins over environment and conflicting settings without normalization", () => {
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", join(root, "environment.sqlite"));
	const path = `${root}/nested/../ explicit.sqlite `;
	const journal = resolve({ journal: { path }, settings: conflicting });
	assert.ok(journal instanceof SqliteRunJournal);
	assert.equal(journal.path, path);
});

test("explicit memory and journal instances are used instead of environment and settings", () => {
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", join(root, "environment.sqlite"));
	assert.ok(resolve({ journal: { memory: true }, settings: conflicting }) instanceof MemoryRunJournal);
	const instance = new MemoryRunJournal();
	assert.equal(resolve({ journal: instance, settings: conflicting }), instance);
	const sqlite = new SqliteRunJournal(join(root, "instance.sqlite"));
	assert.equal(resolve({ journal: sqlite, settings: conflicting }), sqlite);
});

test("explicit caller-owned connection wins and stays open", async () => {
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", join(root, "environment.sqlite"));
	const database = new DatabaseSync(join(root, "caller.sqlite"));
	try {
		const journal = resolve({ journal: { database }, settings: conflicting });
		assert.ok(journal instanceof SqliteRunJournal);
		await journal.close();
		assert.equal(database.prepare("SELECT schema_version FROM meta").get()?.schema_version, 1);
	} finally {
		database.close();
	}
});

test("nonempty environment overrides settings including a conflicting block", () => {
	const path = join(root, " environment.sqlite ");
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", path);
	const journal = resolve({ settings: conflicting });
	assert.ok(journal instanceof SqliteRunJournal);
	assert.equal(journal.path, path);
});

test("settings path resolves relative to Atomic home and overrides the default", () => {
	const journal = resolve({ settings: { workflows: { journal: { path: "nested/settings.sqlite", memory: false } } } });
	assert.ok(journal instanceof SqliteRunJournal);
	assert.equal(journal.path, join(dirname(getAgentDir()), "nested/settings.sqlite"));
});

test("absolute settings paths are preserved", () => {
	const path = join(root, "absolute.sqlite");
	const journal = resolve({ settings: { workflows: { journal: { path } } } });
	assert.ok(journal instanceof SqliteRunJournal);
	assert.equal(journal.path, path);
});

test("settings memory true selects memory even when path is empty", () => {
	for (const path of [undefined, ""]) {
		assert.ok(resolve({ settings: { workflows: { journal: { path, memory: true } } } }) instanceof MemoryRunJournal);
	}
});

test("absent and empty settings and memory false use the persistent default", () => {
	for (const settings of [
		undefined,
		{},
		{ workflows: [] },
		{ workflows: { journal: {} } },
		{ workflows: { journal: { path: "", memory: false } } },
	]) {
		const journal = resolve({ settings });
		assert.ok(journal instanceof SqliteRunJournal);
		assert.equal(journal.path, join(dirname(getAgentDir()), "workflows", "journal.sqlite"));
	}
});

test("selected settings with nonempty path and memory true fail with exact typed fields", () => {
	assert.throws(
		() => resolve({ settings: conflicting }),
		(error: Error) => {
			assert.ok(error instanceof JournalConfigurationError);
			assert.equal(error.source, "settings");
			assert.equal(error.setting, "workflows.journal");
			assert.equal(error.reason, "path-and-memory");
			return true;
		},
	);
});
