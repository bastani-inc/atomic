import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { moduleDir, readText } from "../helpers/runtime.js";

test("the documented custom driver is exactly the wrapper exercised by conformance", async () => {
	const root = join(moduleDir(import.meta.url), "../..");
	const docs = await readText(join(root, "packages/coding-agent/docs/storage.md"));
	const fixture = await readText(join(root, "test/fixtures/storage-libsql-wrapper.ts"));
	const example = docs.match(
		/\{\/\* custom-driver-example \*\/\}\n```ts\n([\s\S]*?)```\n\{\/\* \/custom-driver-example \*\/\}/,
	);
	assert.ok(example, "storage guide must include the complete custom driver example");
	assert.equal(
		example[1],
		fixture.replace("../../packages/coding-agent/src/core/storage/index.js", "@bastani/atomic/storage"),
	);
});
