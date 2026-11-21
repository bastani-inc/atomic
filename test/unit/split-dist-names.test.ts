import assert from "node:assert/strict";
import { test } from "vitest";
import { sharedFileName } from "../../packages/coding-agent/scripts/split-dist-names.mjs";

const output = "dist/_shared/chunk-ABCDEFGH.js";
const meta = (inputs: string[], exports: string[], entryPoint?: string) => ({
	inputs: Object.fromEntries(inputs.map((input) => [input, {}])),
	exports,
	entryPoint,
});

test("a shared file keeps its name while its first module and its exports stay the same", () => {
	const name = sharedFileName("chunk", meta(["dist/core/a.js", "dist/core/b.js"], ["b", "a"]), output);
	assert.match(name, /^chunk-[A-Z2-7]{8}\.js$/);
	// Another module after the first, another order of the same exports: the same name.
	assert.equal(sharedFileName("chunk", meta(["dist/core/c.js", "dist/core/a.js"], ["a", "b"]), output), name);
});

test("a shared file whose exports change takes another name, so code that imports a new export never meets the old file", () => {
	const name = sharedFileName("chunk", meta(["dist/core/a.js"], ["a"]), output);
	assert.notEqual(sharedFileName("chunk", meta(["dist/core/a.js"], ["a", "added"]), output), name);
	assert.notEqual(sharedFileName("chunk", meta(["dist/core/a.js"], []), output), name);
	// esbuild renames a colliding export; that changes what an importer asks for, so it changes the name too.
	assert.notEqual(sharedFileName("chunk", meta(["dist/core/a.js"], ["a2"]), output), name);
});

test("an inlined dependency does not name a shared file that holds one of the package's own modules", () => {
	const own = sharedFileName("chunk", meta(["dist/core/a.js"], ["a"]), output);
	assert.equal(
		sharedFileName("chunk", meta(["../../node_modules/dep/index.js", "dist/core/a.js"], ["a"]), output),
		own,
	);
});

test("a shared file that only re-exports a dynamically imported module is named by that module", () => {
	const first = sharedFileName("lazy", meta([], ["run"], "dist/core/a.js"), output);
	assert.notEqual(sharedFileName("lazy", meta([], ["run"], "dist/core/b.js"), output), first);
	assert.equal(sharedFileName("lazy", meta([], ["run"], "dist/core/a.js"), output), first);
});
