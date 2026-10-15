import assert from "node:assert/strict";
import { join } from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { test } from "vitest";
import { SettingsSchema } from "../../packages/coding-agent/src/core/settings-schema.js";
import { moduleDir, readJson } from "../helpers/runtime.js";

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
