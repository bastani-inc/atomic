import assert from "node:assert/strict";
import { join } from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { test } from "vitest";
import { deepMergeSettings } from "../../packages/coding-agent/src/core/settings-merge.js";
import { SettingsSchema } from "../../packages/coding-agent/src/core/settings-schema.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { JournalConfigurationError } from "../../packages/workflows/src/durable/journal/types.js";
import { makeTempDirectory, moduleDir, readJson, removeTempDirectory } from "../helpers/runtime.js";

const accepted = [
	{},
	{ path: "journal.sqlite" },
	{ path: "" },
	{ memory: true },
	{ memory: false },
	{ path: "journal.sqlite", memory: false },
	{ path: "", memory: true },
	{ path: "", memory: false },
];
const rejected = [
	{ path: "journal.sqlite", memory: true },
	{ path: " ", memory: true },
	{ path: 123 },
	{ path: null },
	{ memory: "true" },
	{ memory: null },
];

test("source and published settings schemas accept journal selections and reject conflicting or invalid values", async () => {
	const generated = await readJson<TSchema>(
		join(moduleDir(import.meta.url), "../../packages/coding-agent/schemas/settings.schema.json"),
	);
	for (const schema of [SettingsSchema, generated]) {
		for (const journal of accepted)
			assert.equal(Value.Check(schema, { workflows: { journal } }), true, JSON.stringify(journal));
		for (const journal of rejected)
			assert.equal(Value.Check(schema, { workflows: { journal } }), false, JSON.stringify(journal));
	}
});

test("project journal memory replaces a global path without changing other nested merges (#3674)", async () => {
	const settings = deepMergeSettings(
		{ workflows: { journal: { path: "global.sqlite" }, paths: ["global"] }, compaction: { reserveTokens: 100 } },
		{ workflows: { journal: { memory: true } }, compaction: { enabled: false } },
	);
	assert.deepEqual(settings.workflows, { journal: { memory: true }, paths: ["global"] });
	assert.deepEqual(settings.compaction, { reserveTokens: 100, enabled: false });
	const journal = await resolveRunJournal({ settings });
	try {
		assert.ok(journal instanceof MemoryRunJournal);
	} finally {
		await journal.close();
	}
});

test("project journal path replaces global memory (#3674)", async () => {
	const directory = makeTempDirectory("journal-settings-");
	const path = join(directory, "project.sqlite");
	try {
		const settings = deepMergeSettings(
			{ workflows: { journal: { memory: true } } },
			{ workflows: { journal: { path } } },
		);
		const journal = await resolveRunJournal({ settings });
		try {
			assert.ok(journal instanceof SqlRunJournal);
			assert.equal(journal.path, path);
		} finally {
			await journal.close();
		}
	} finally {
		removeTempDirectory(directory);
	}
});

test("a conflicting journal within either scope still throws JournalConfigurationError (#3674)", async () => {
	const conflict = { workflows: { journal: { path: "conflict.sqlite", memory: true } } };
	for (const settings of [deepMergeSettings(conflict, {}), deepMergeSettings({}, conflict)]) {
		await assert.rejects(
			() => resolveRunJournal({ settings }),
			(error: Error) => {
				assert.ok(error instanceof JournalConfigurationError);
				assert.equal(error.reason, "path-and-memory");
				return true;
			},
		);
	}
});
