// Exercises the dist refresh `npm run typecheck` runs, on a small package outside the workspace.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { moveChangedFiles } from "./refresh-package-dist.mjs";

const script = fileURLToPath(new URL("./refresh-package-dist.mjs", import.meta.url));
const typescript = createRequire(import.meta.url).resolve("typescript/package.json");
const tsc = join(dirname(typescript), JSON.parse(readFileSync(typescript, "utf8")).bin.tsc);

function workspace(t) {
	const directory = mkdtempSync(join(tmpdir(), "atomic-refresh-dist-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

/** A package whose build is `tsc -p tsconfig.build.json`, with declarations and both kinds of source maps. */
function writePackage(directory, source) {
	mkdirSync(join(directory, "src"), { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
	writeFileSync(
		join(directory, "tsconfig.build.json"),
		JSON.stringify({
			compilerOptions: {
				target: "ES2024",
				module: "NodeNext",
				declaration: true,
				declarationMap: true,
				sourceMap: true,
				outDir: "./dist",
				rootDir: "./src",
				types: [],
			},
			include: ["src/**/*.ts"],
		}),
	);
	writeFileSync(join(directory, "src", "index.ts"), source);
}

function build(directory) {
	const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: directory, encoding: "utf8" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
}

function refresh(directory) {
	const result = spawnSync(process.execPath, [script, directory], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	return result.stdout;
}

/** Identity and modification time of every file under `directory`. */
function fileStates(directory) {
	return Object.fromEntries(
		readdirSync(directory, { recursive: true })
			.filter((file) => statSync(join(directory, file)).isFile())
			.sort()
			.map((file) => {
				const stats = statSync(join(directory, file), { bigint: true });
				return [file, `${stats.ino}:${stats.mtimeNs}`];
			}),
	);
}

test("an up-to-date dist is left exactly as it was: no file is written", (t) => {
	const directory = workspace(t);
	writePackage(directory, "export const answer: number = 42;\n");
	build(directory);
	const before = fileStates(join(directory, "dist"));
	assert.deepEqual(Object.keys(before), ["index.d.ts", "index.d.ts.map", "index.js", "index.js.map"]);
	const output = refresh(directory);
	assert.deepEqual(fileStates(join(directory, "dist")), before);
	assert.match(output, /: 0 of 4 files changed/);
	assert.deepEqual(
		readdirSync(directory).filter((entry) => entry.startsWith(".dist-staging-")),
		[],
		"the staging directory is removed",
	);
});

test("a changed output replaces the old file whole, so a reader that opened the old one still reads all of it", (t) => {
	const directory = workspace(t);
	writePackage(directory, "export const answer: number = 42;\n");
	build(directory);
	const output = join(directory, "dist", "index.js");
	const old = readFileSync(output);
	const reader = openSync(output, "r");
	t.after(() => closeSync(reader));
	writePackage(directory, 'export const answer: number = 43;\nexport const question = "unknown";\n');
	assert.match(refresh(directory), /: 4 of 4 files changed/);

	const read = Buffer.alloc(old.length + 64);
	const length = readSync(reader, read, 0, read.length, 0);
	assert.equal(read.subarray(0, length).toString(), old.toString());
	assert.match(readFileSync(output, "utf8"), /answer = 43;\nexport const question = "unknown";/);
});

test("outputs whose source was removed stay, while a mirrored directory loses files its source no longer has", (t) => {
	const directory = workspace(t);
	const staged = join(directory, "staged");
	const dist = join(directory, "dist");
	mkdirSync(join(staged, "data"), { recursive: true });
	mkdirSync(join(dist, "data"), { recursive: true });
	writeFileSync(join(staged, "index.js"), "same");
	writeFileSync(join(dist, "index.js"), "same");
	writeFileSync(join(dist, "removed-source.js"), "stale output");
	writeFileSync(join(staged, "data", "kept.json"), "{}");
	writeFileSync(join(staged, "data", "added.json"), '{"added":true}');
	writeFileSync(join(dist, "data", "kept.json"), "{}");
	writeFileSync(join(dist, "data", "dropped.json"), "{}");

	const result = moveChangedFiles(staged, dist, ["data"]);

	assert.deepEqual(result, { files: 3, replaced: ["data/added.json"], removed: ["data/dropped.json"] });
	assert.equal(readFileSync(join(dist, "removed-source.js"), "utf8"), "stale output");
	assert.equal(readFileSync(join(dist, "data", "added.json"), "utf8"), '{"added":true}');
	assert.equal(existsSync(join(dist, "data", "dropped.json")), false);
});
