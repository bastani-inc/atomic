import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.js";
import { createEditToolDefinition } from "../src/core/tools/edit.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-legacy-input-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool prepareArguments", () => {
	it("keeps legacy fields out of the public schema", () => {
		const definition = createEditToolDefinition(process.cwd());
		assert.equal(Object.hasOwn(definition.parameters.properties, "oldText"), false);
		assert.equal(Object.hasOwn(definition.parameters.properties, "newText"), false);
	});

	it("folds top-level oldText/newText into edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			oldText: "before",
			newText: "after",
		});
		assert.deepEqual(prepared, {
			path: "file.txt",
			edits: [{ oldText: "before", newText: "after" }],
		});
	});

	it("appends legacy replacement to existing edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
			oldText: "c",
			newText: "d",
		});
		assert.deepEqual(prepared, {
			path: "file.txt",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c", newText: "d" },
			],
		});
	});

	it("passes through valid input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = {
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		};
		const prepared = definition.prepareArguments!(input);
		assert.equal(prepared, input);
	});

	it("passes through non-object input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		assert.equal(definition.prepareArguments!(null), null);
		assert.equal(definition.prepareArguments!(undefined), undefined);
		assert.equal(definition.prepareArguments!("garbage"), "garbage");
	});

	it("prepared args execute correctly", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "legacy.txt");
		await writeFile(filePath, "before\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const prepared = definition.prepareArguments!({
			path: "legacy.txt",
			oldText: "before",
			newText: "after",
		});

		const result = await definition.execute("tool-1", prepared, undefined, undefined, {} as ExtensionToolContext);
		assert.deepEqual(result.content, [{ type: "text", text: "Successfully replaced 1 block(s) in legacy.txt." }]);
		assert.equal(await readFile(filePath, "utf8"), "after\n");
	});
});

describe("edit tool stringified edits", () => {
	it("parses edits from a JSON string", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
		});
		assert.deepEqual(prepared, {
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		});
	});

	it("leaves edits alone when the string is not valid JSON", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: "not json",
		});
		assert.deepEqual(prepared, {
			path: "file.txt",
			edits: "not json",
		});
	});
});
