import assert from "node:assert/strict";
import { join } from "node:path";
import { StorageConfigError } from "@bastani/atomic/storage";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { test } from "vitest";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { deepMergeSettings } from "../../packages/coding-agent/src/core/settings-merge.js";
import { SettingsSchema } from "../../packages/coding-agent/src/core/settings-schema.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	makeTempDirectory,
	moduleDir,
	readJson,
	removeTempDirectory,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

const accepted = [
	{},
	{ path: "journal.sqlite" },
	{ path: "" },
	{ memory: true },
	{ memory: false },
	{ path: "journal.sqlite", memory: false },
	{ path: "", memory: true },
	{ path: "", memory: false },
	{
		adapter: "@example/storage",
		options: { url: "url", enabled: false, absent: null },
		secrets: { token: { env: "TOKEN" }, file: { file: "secret" } },
		prefix: "test_",
	},
];
const rejected = [
	{ path: "journal.sqlite", memory: true },
	{ path: " ", memory: true },
	{ path: 123 },
	{ path: null },
	{ memory: "true" },
	{ memory: null },
	{ adapter: "" },
	{ adapter: "x", path: "" },
	{ adapter: "x", memory: false },
	{ adapter: "x", options: { nested: {} } },
	{ adapter: "x", secrets: { token: { env: "A", file: "B" } } },
];

test("source and published settings schemas accept journal selections and reject conflicting or invalid values", async () => {
	const generated = await readJson<TSchema>(
		join(moduleDir(import.meta.url), "../../packages/coding-agent/schemas/settings.schema.json"),
	);
	for (const schema of [SettingsSchema, generated]) {
		for (const journal of accepted)
			assert.equal(Value.Check(schema, { workflows: { journal } }), true, JSON.stringify(journal));
		for (const storage of accepted) assert.equal(Value.Check(schema, { storage }), true, JSON.stringify(storage));
		for (const journal of rejected)
			assert.equal(Value.Check(schema, { workflows: { journal } }), false, JSON.stringify(journal));
		for (const storage of rejected) assert.equal(Value.Check(schema, { storage }), false, JSON.stringify(storage));
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

test("a conflicting journal within either scope still throws StorageConfigError (#3674)", async () => {
	const conflict = { workflows: { journal: { path: "conflict.sqlite", memory: true } } };
	for (const settings of [deepMergeSettings(conflict, {}), deepMergeSettings({}, conflict)]) {
		await assert.rejects(
			() => resolveRunJournal({ settings }),
			(error: Error) => {
				assert.ok(error instanceof StorageConfigError);
				assert.equal(error.reason, "path-and-memory");
				return true;
			},
		);
	}
});

test("scoped settings and overrides replace complete adapter selections and respect project trust", async () => {
	const root = makeTempDirectory("storage-settings-");
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const global = {
		adapter: "global",
		options: { url: "global" },
		secrets: { token: { env: "TOKEN" } },
		prefix: "global_",
	};
	const project = { adapter: "project", options: { url: "project" } };
	try {
		await writeFileEnsuringDir(
			join(agentDir, "settings.json"),
			JSON.stringify({ storage: global, workflows: { journal: global } }),
		);
		await writeFileEnsuringDir(
			join(cwd, ".atomic", "settings.json"),
			JSON.stringify({ storage: project, workflows: { journal: project } }),
		);
		const settings = SettingsManager.create(cwd, agentDir);
		assert.deepEqual(settings.getSettings().storage, project);
		assert.deepEqual(settings.getSettings().workflows, { journal: project });
		settings.applyOverrides({ storage: { memory: true }, workflows: { journal: { memory: true } } });
		assert.deepEqual(settings.getSettings().storage, { memory: true });
		assert.deepEqual(settings.getSettings().workflows, { journal: { memory: true } });
		const untrusted = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		assert.deepEqual(untrusted.getSettings().storage, global);
		assert.deepEqual(untrusted.getSettings().workflows, { journal: global });
	} finally {
		removeTempDirectory(root);
	}
});
