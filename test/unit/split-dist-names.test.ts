import assert from "node:assert/strict";
import { test } from "vitest";
import { compatSharedFiles, sharedFileName } from "../../packages/coding-agent/scripts/split-dist-names.mjs";

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

/** A shared file an earlier release imports on demand: the module's file before its exports grew. */
const released = {
	version: "0.10.4-alpha.1",
	path: "_shared/compile-cache-warmup-host-OQZHHQ2Z.js",
	names: ["warmCompileCache", "startCompileCacheHelper"],
};

test("a shared file an earlier release imports on demand stays, re-exporting what it had from this split's file of the module", () => {
	const outputs = [
		{
			file: "compile-cache-warmup-host-RU5L7I7A.js",
			stem: "compile-cache-warmup-host",
			exports: ["compileCacheWarmupRuntimes", "startCompileCacheHelper", "warmCompileCache"],
		},
		{ file: "chunk-HPXIRGJN.js", stem: "chunk", exports: ["warmCompileCache", "startCompileCacheHelper"] },
	];
	assert.deepEqual(compatSharedFiles([released, released], outputs, "_shared"), [
		{
			path: "_shared/compile-cache-warmup-host-OQZHHQ2Z.js",
			contents:
				'export { startCompileCacheHelper, warmCompileCache } from "./compile-cache-warmup-host-RU5L7I7A.js";\n//# sourceMappingURL=compile-cache-warmup-host-OQZHHQ2Z.js.map\n',
		},
		{
			path: "_shared/compile-cache-warmup-host-OQZHHQ2Z.js.map",
			contents:
				'{"version":3,"file":"compile-cache-warmup-host-OQZHHQ2Z.js","sources":[],"names":[],"mappings":""}\n',
		},
	]);
	// Still written by this split: nothing to add.
	assert.deepEqual(
		compatSharedFiles(
			[released],
			[
				{
					file: "compile-cache-warmup-host-OQZHHQ2Z.js",
					stem: "compile-cache-warmup-host",
					exports: released.names,
				},
			],
			"_shared",
		),
		[],
	);
});

test("the build fails when no file of this split, or more than one, can stand for a shared file an earlier release imports", () => {
	const lacking = [
		{
			file: "compile-cache-warmup-host-RU5L7I7A.js",
			stem: "compile-cache-warmup-host",
			exports: ["warmCompileCache"],
		},
	];
	assert.throws(
		() => compatSharedFiles([released], lacking, "_shared"),
		/0\.10\.4-alpha\.1 imports dist\/_shared\/compile-cache-warmup-host-OQZHHQ2Z\.js on demand, and no shared file of this build holds its module with its exports \(warmCompileCache, startCompileCacheHelper\)/,
	);
	const twice = [
		{ file: "compile-cache-warmup-host-AAAAAAAA.js", stem: "compile-cache-warmup-host", exports: released.names },
		{ file: "compile-cache-warmup-host-BBBBBBBB.js", stem: "compile-cache-warmup-host", exports: released.names },
	];
	assert.throws(() => compatSharedFiles([released], twice, "_shared"), /more than one shared file/);
});
