/**
 * The list of files an interactive start reads ahead on Windows (`dist/startup-files.json`) in the package npm
 * publishes. A release compiles the modules its binaries need and lists them before `npm pack` splits the package, so
 * the published list must come from the files that are packed, not from what the build left before packing.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, posix, resolve } from "node:path";
import { afterAll, test } from "vitest";
import { moduleDir, npmSpawnPrefix, spawnSyncCollect } from "../helpers/runtime.js";
import { removeTestDirectory } from "../helpers/test-directory-removal.js";

const repoRoot = resolve(moduleDir(import.meta.url), "../..");
const packageDir = join(repoRoot, "packages", "coding-agent");
/** Copying the built package, then splitting it, tracing its startup and packing it as `npm pack` does, is structural. */
const PACK_TIMEOUT_MS = 300_000;

let workspace: string | undefined;
afterAll(() => {
	if (workspace) removeTestDirectory(workspace, { retries: 20, retryDelayMs: 50 });
}, PACK_TIMEOUT_MS);

/** Copies a directory tree file by file, following links. */
function copyTree(source: string, target: string): void {
	fs.mkdirSync(target, { recursive: true });
	for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
		const from = join(source, entry.name);
		if (fs.statSync(from).isDirectory()) copyTree(from, join(target, entry.name));
		else fs.copyFileSync(from, join(target, entry.name));
	}
}

/**
 * The built package, its build scripts and build state copied into a workspace of its own whose other packages link to
 * this one's: packing it runs the package's own lifecycle scripts without touching the repository's build.
 */
function copiedPackage(root: string): string {
	const linkType = process.platform === "win32" ? "junction" : "dir";
	const repoNodeModules = join(repoRoot, "node_modules");
	const nodeModules = join(root, "node_modules");
	fs.mkdirSync(nodeModules, { recursive: true });
	for (const name of fs.readdirSync(repoNodeModules)) {
		if (name === ".bin" || name === ".cache") continue;
		const source = join(repoNodeModules, name);
		if (!fs.statSync(source).isDirectory()) continue;
		if (name.startsWith("@")) {
			fs.mkdirSync(join(nodeModules, name), { recursive: true });
			for (const scoped of fs.readdirSync(source)) {
				if (name === "@bastani" && scoped === "atomic") continue;
				fs.symlinkSync(fs.realpathSync(join(source, scoped)), join(nodeModules, name, scoped), linkType);
			}
			continue;
		}
		fs.symlinkSync(fs.realpathSync(source), join(nodeModules, name), linkType);
	}
	const copy = join(root, "packages", "coding-agent");
	fs.mkdirSync(copy, { recursive: true });
	fs.copyFileSync(join(packageDir, "package.json"), join(copy, "package.json"));
	for (const directory of ["scripts", "dist", "node_modules"])
		copyTree(join(packageDir, directory), join(copy, directory));
	return copy;
}

/** A file's code without its comment lines: a bundled dependency's documentation may name an import. */
function codeOf(path: string): string {
	return fs
		.readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
		.join("\n");
}

/** The `dist` files a module loads before it runs, through its static imports, transitively. */
function staticallyLoaded(dist: string, files: readonly string[]): Set<string> {
	const seen = new Set<string>();
	const pending = [...files];
	while (pending.length > 0) {
		const file = pending.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const match of codeOf(join(dist, file)).matchAll(/(?:\bfrom|\bimport)\s*"(\.{1,2}\/[^"]+)"/g)) {
			pending.push(posix.normalize(posix.join(posix.dirname(file), match[1] as string)));
		}
	}
	return seen;
}

test(
	"the packed package's startup list names only packed files and every file the CLI then imports to start",
	() => {
		workspace = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "atomic-packed-startup-files-")));
		const copy = copiedPackage(workspace);
		// What the release build leaves: a list of the files of the layout it built, which the pack then changes.
		fs.writeFileSync(
			join(copy, "dist", "startup-files.json"),
			JSON.stringify({
				version: 2,
				self: "@bastani/atomic",
				packages: [["@bastani/atomic", -1]],
				files: [[0, "dist/compiled-before-the-split.js"]],
			}),
		);
		const out = join(workspace, "packed");
		fs.mkdirSync(out);
		const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)));
		const packed = spawnSyncCollect([...npmSpawnPrefix(), "pack", copy, "--json", "--pack-destination", out], {
			cwd: workspace,
			env,
			timeout: PACK_TIMEOUT_MS,
		});
		assert.equal(packed.exitCode, 0, packed.stderr.toString());
		const stdout = packed.stdout.toString();
		const [{ files }] = JSON.parse(stdout.slice(stdout.indexOf("[\n"))) as [{ files: { path: string }[] }];
		const paths = new Set(files.map((file) => file.path));
		assert.ok(paths.has("dist/startup-files.json"), "the list is packed");

		const list = JSON.parse(fs.readFileSync(join(copy, "dist", "startup-files.json"), "utf8")) as {
			self: string;
			packages: [string, number][];
			files: [number, string][];
		};
		const listed = list.files.filter(([index]) => list.packages[index]?.[0] === list.self).map(([, path]) => path);
		assert.deepEqual(
			listed.filter((path) => !paths.has(path)),
			[],
			"every file the list names is in the package",
		);

		// The CLI starts the reader, then imports what it runs (`import("./…")`); each of those loads its static imports
		// before it runs, and the reader must have them.
		const dist = join(copy, "dist");
		const imported = [...codeOf(join(dist, "cli.js")).matchAll(/\bimport\(\s*"(\.\/[^"]+)"\s*\)/g)].map((match) =>
			posix.normalize(match[1] as string),
		);
		assert.ok(imported.includes("main.js"), "the CLI imports main.js when it runs");
		const listedSet = new Set(listed);
		assert.deepEqual(
			[...staticallyLoaded(dist, imported)].map((file) => `dist/${file}`).filter((path) => !listedSet.has(path)),
			[],
			"the list names every file the CLI's imports load",
		);
	},
	PACK_TIMEOUT_MS,
);
