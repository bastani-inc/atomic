import assert from "node:assert/strict";
import { join } from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { test } from "vitest";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { SettingsSchema } from "../../packages/coding-agent/src/core/settings-schema.js";
import {
	makeTempDirectory,
	moduleDir,
	readJson,
	removeTempDirectory,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

const accepted = [
	{},
	{ path: "data.sqlite" },
	{ path: "" },
	{ memory: true },
	{ memory: false },
	{ path: "data.sqlite", memory: false },
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
	{ path: "data.sqlite", memory: true },
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

test("source and published settings schemas agree on valid storage selections", async () => {
	const generated = await readJson<TSchema>(
		join(moduleDir(import.meta.url), "../../packages/coding-agent/schemas/settings.schema.json"),
	);
	for (const schema of [SettingsSchema, generated]) {
		for (const storage of accepted) assert.equal(Value.Check(schema, { storage }), true, JSON.stringify(storage));
		for (const storage of rejected) assert.equal(Value.Check(schema, { storage }), false, JSON.stringify(storage));
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
			JSON.stringify({ storage: global, compaction: { reserveTokens: 100 } }),
		);
		await writeFileEnsuringDir(
			join(cwd, ".atomic", "settings.json"),
			JSON.stringify({ storage: project, compaction: { enabled: false } }),
		);
		const settings = SettingsManager.create(cwd, agentDir);
		assert.deepEqual(settings.getSettings().storage, project);
		assert.deepEqual(settings.getSettings().compaction, { reserveTokens: 100, enabled: false });
		settings.applyOverrides({ storage: { memory: true } });
		assert.deepEqual(settings.getSettings().storage, { memory: true });
		const untrusted = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		assert.deepEqual(untrusted.getSettings().storage, global);
	} finally {
		removeTempDirectory(root);
	}
});
