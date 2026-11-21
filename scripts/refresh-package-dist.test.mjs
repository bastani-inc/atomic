// Exercises the dist refresh `npm run typecheck` runs, on a small package outside the workspace.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { moveChangedFiles } from "./refresh-package-dist.mjs";

const script = fileURLToPath(new URL("./refresh-package-dist.mjs", import.meta.url));
const bundler = fileURLToPath(new URL("./bundle-package-dist.mjs", import.meta.url));
const typescript = createRequire(import.meta.url).resolve("typescript/package.json");
const tsc = join(dirname(typescript), JSON.parse(readFileSync(typescript, "utf8")).bin.tsc);

/** How long a refresh may take to stage its output: one small tsc run on a busy machine. */
const REFRESH_WAIT_MS = 60_000;

/** Whether a staging directory of the package in `directory` holds `file`. */
function stagedOutput(directory, file) {
	return readdirSync(directory).some(
		(entry) => entry.startsWith(".dist-staging-") && existsSync(join(directory, entry, file)),
	);
}

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

test("a changed output is never written while a reader has the old file open: the reader reads all of the old one", async (t) => {
	const directory = workspace(t);
	writePackage(directory, "export const answer: number = 42;\n");
	build(directory);
	const output = join(directory, "dist", "index.js");
	const old = readFileSync(output);
	let reader = openSync(output, "r");
	t.after(() => {
		if (reader !== undefined) closeSync(reader);
	});
	writePackage(directory, 'export const answer: number = 43;\nexport const question = "unknown";\n');

	const child = spawn(process.execPath, [script, directory], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => {
		stdout += chunk;
	});
	const exited = new Promise((resolve) => child.once("close", (status) => resolve(status)));
	let done = false;
	void exited.then(() => {
		done = true;
	});
	if (process.platform === "win32") {
		// Windows refuses to replace a file a reader has open. Once the new index.js is staged the refresh is about to
		// replace the old one, so it waits until this reader has read the old file and closed it.
		const deadline = Date.now() + REFRESH_WAIT_MS;
		while (!done && !stagedOutput(directory, "index.js")) {
			assert.ok(Date.now() < deadline, "the refresh never staged index.js");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	} else {
		// Elsewhere the new file takes the old one's name while the reader keeps the old file.
		await exited;
	}
	const read = Buffer.alloc(old.length + 64);
	const length = readSync(reader, read, 0, read.length, 0);
	closeSync(reader);
	reader = undefined;
	assert.equal(read.subarray(0, length).toString(), old.toString());

	assert.equal(await exited, 0);
	assert.match(stdout, /: 4 of 4 files changed/);
	assert.match(readFileSync(output, "utf8"), /answer = 43;\nexport const question = "unknown";/);
});

test("a replaced file keeps its permissions, outputs whose source was removed stay, and a mirrored directory loses files its source no longer has", (t) => {
	const directory = workspace(t);
	const staged = join(directory, "staged");
	const dist = join(directory, "dist");
	mkdirSync(join(staged, "data"), { recursive: true });
	mkdirSync(join(dist, "data"), { recursive: true });
	writeFileSync(join(staged, "index.js"), "same");
	writeFileSync(join(dist, "index.js"), "same");
	writeFileSync(join(staged, "changed.js"), "new output");
	writeFileSync(join(dist, "changed.js"), "old output");
	chmodSync(join(dist, "changed.js"), 0o640);
	writeFileSync(join(dist, "removed-source.js"), "stale output");
	writeFileSync(join(staged, "data", "kept.json"), "{}");
	writeFileSync(join(staged, "data", "added.json"), '{"added":true}');
	writeFileSync(join(dist, "data", "kept.json"), "{}");
	writeFileSync(join(dist, "data", "dropped.json"), "{}");

	const result = moveChangedFiles(staged, dist, ["data"]);

	assert.deepEqual(result, {
		files: 4,
		replaced: ["changed.js", "data/added.json"],
		removed: ["data/dropped.json"],
	});
	assert.equal(readFileSync(join(dist, "changed.js"), "utf8"), "new output");
	// The replacement keeps the replaced file's permissions, as a build that rewrote it in place did.
	if (process.platform !== "win32") assert.equal(statSync(join(dist, "changed.js")).mode & 0o777, 0o640);
	assert.equal(readFileSync(join(dist, "removed-source.js"), "utf8"), "stale output");
	assert.equal(readFileSync(join(dist, "data", "added.json"), "utf8"), '{"added":true}');
	assert.equal(existsSync(join(dist, "data", "dropped.json")), false);
});

test("a package that ships bundled is bundled before its files move, so its dist ends with the bundled files", (t) => {
	const directory = workspace(t);
	writePackage(directory, 'import { helper } from "./helper.js";\nexport const answer: number = helper();\n');
	writeFileSync(join(directory, "src", "helper.ts"), "export function helper(): number {\n\treturn 42;\n}\n");
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({
			name: "fixture",
			type: "module",
			main: "./dist/index.js",
			scripts: { "build:bundle": `node ${JSON.stringify(bundler)}` },
		}),
	);
	refresh(directory);
	const dist = join(directory, "dist");
	const shared = readdirSync(dist).filter((name) => /^_main-[A-Z2-7]{8}\.js$/.test(name));
	assert.equal(shared.length, 1, readdirSync(dist).join(", "));
	assert.match(readFileSync(join(dist, "index.js"), "utf8"), new RegExp(`from "\\./${shared[0]}"`));
	assert.equal(existsSync(join(dist, "index.js.map")), false, "a re-exporting file has no map");
	const imported = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const m = await import(${JSON.stringify(pathToFileURL(join(dist, "index.js")).href)}); process.stdout.write(String(m.answer));`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(imported.stdout, "42", imported.stderr);
	// The next refresh bundles the same files again, so it writes nothing.
	const before = fileStates(dist);
	assert.match(refresh(directory), /: 0 of \d+ files changed/);
	assert.deepEqual(fileStates(dist), before);
});

test("a refresh removes the shared files an earlier bundle wrote that this one does not", (t) => {
	const directory = workspace(t);
	writePackage(directory, 'import { helper } from "./helper.js";\nexport const answer: number = helper();\n');
	writeFileSync(join(directory, "src", "helper.ts"), "export function helper(): number {\n\treturn 42;\n}\n");
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({
			name: "fixture",
			type: "module",
			main: "./dist/index.js",
			scripts: { "build:bundle": `node ${JSON.stringify(bundler)}` },
		}),
	);
	refresh(directory);
	const dist = join(directory, "dist");
	const sharedFiles = () =>
		readdirSync(dist)
			.filter((name) => /^_main-[A-Z2-7]{8}\.js(\.map)?$/.test(name))
			.sort();
	const earlier = sharedFiles();
	assert.equal(earlier.length, 2, earlier.join(", "));
	// A shared file is named by its first module, so a module renamed in the source moves its code to a new one.
	writeFileSync(
		join(directory, "src", "index.ts"),
		'import { helper } from "./aid.js";\nexport const answer: number = helper();\n',
	);
	rmSync(join(directory, "src", "helper.ts"));
	writeFileSync(join(directory, "src", "aid.ts"), "export function helper(): number {\n\treturn 43;\n}\n");
	writeFileSync(join(dist, "notes.js"), "export {};\n");
	assert.match(refresh(directory), /, 2 removed/);
	const now = sharedFiles();
	assert.equal(now.length, 2, now.join(", "));
	assert.deepEqual(
		now.filter((name) => earlier.includes(name)),
		[],
	);
	assert.match(readFileSync(join(dist, "index.js"), "utf8"), new RegExp(`from "\\./${now[0]}"`));
	assert.ok(existsSync(join(dist, "notes.js")), "a file the bundle did not write stays");
	const imported = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const m = await import(${JSON.stringify(pathToFileURL(join(dist, "index.js")).href)}); process.stdout.write(String(m.answer));`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(imported.stdout, "43", imported.stderr);
});
