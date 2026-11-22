/**
 * What the build writes about an interactive start's modules, in the package npm publishes: the list of files the start
 * reads ahead on Windows (`dist/startup-files.json`) and the stages it loads them in (`dist/startup-stages/`). A release
 * compiles the modules its binaries need and writes both before `npm pack` splits the package, so the published ones
 * must come from the files that are packed, not from what the build left before packing.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { afterAll, test } from "vitest";
import { undiciTombstoneEntries } from "../../packages/coding-agent/scripts/undici-tombstone.mjs";
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
 * The built package, its build scripts, the release records its split reads and its build state copied into a workspace
 * of its own whose other packages link to
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
	fs.copyFileSync(join(repoRoot, ".npmrc"), join(root, ".npmrc"));
	fs.copyFileSync(join(packageDir, "package.json"), join(copy, "package.json"));
	// The build's inputs besides the compiled files: its scripts and the records of earlier releases the split reads.
	for (const directory of ["scripts", "in-place-update", "dist", "node_modules"])
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

/** The modules `cli.js` imports as it runs (`import("./…")`), as paths inside `dist`. */
function cliImports(dist: string): string[] {
	return [...codeOf(join(dist, "cli.js")).matchAll(/\bimport\(\s*"(\.\/[^"]+)"\s*\)/g)].map((match) =>
		posix.normalize(match[1] as string),
	);
}

interface Packed {
	/** The copied package, as `npm pack` left it once it had packed it. */
	readonly copy: string;
	/** The packed tarball path. */
	readonly tarball: string;
	/** The paths of the packed files. */
	readonly paths: Set<string>;
}

let packed: Packed | undefined;
/**
 * The built package packed as a release packs it: copied, then left a list and a stage written for the layout the
 * build had before the split, then packed by `npm pack` with its lifecycle scripts.
 */
function packedPackage(): Packed {
	if (packed) return packed;
	workspace = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "atomic-packed-startup-files-")));
	const copy = copiedPackage(workspace);
	fs.writeFileSync(
		join(copy, "dist", "startup-files.json"),
		JSON.stringify({
			version: 2,
			self: "@bastani/atomic",
			packages: [["@bastani/atomic", -1]],
			files: [[0, "dist/compiled-before-the-split.js"]],
		}),
	);
	fs.writeFileSync(join(copy, "dist", "startup-stages", "0.js"), 'import "../compiled-before-the-split.js";\n');
	const out = join(workspace, "npm-packages");
	fs.mkdirSync(out);
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)));
	// Same relative command publish.yml runs from the repository root: `npm pack ./packages/coding-agent --pack-destination npm-packages`.
	const result = spawnSyncCollect(
		[...npmSpawnPrefix(), "pack", "./packages/coding-agent", "--json", "--pack-destination", "npm-packages"],
		{
			cwd: workspace,
			env,
			timeout: PACK_TIMEOUT_MS,
		},
	);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	const stdout = result.stdout.toString();
	const [{ filename, files }] = JSON.parse(stdout.slice(stdout.indexOf("[\n"))) as [
		{ filename: string; files: { path: string }[] },
	];
	packed = { copy, tarball: join(out, filename), paths: new Set(files.map((file) => file.path)) };
	return packed;
}

test(
	"the packed package's startup list names only packed files and every file the CLI then imports to start",
	() => {
		const { copy, paths } = packedPackage();
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
		const imported = cliImports(dist);
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

// A stage that imported a file the CLI's own imports do not load would run a second copy of that module.
test(
	"the packed package's startup stages import only files that the CLI's imports load",
	() => {
		const { copy, paths } = packedPackage();
		const dist = join(copy, "dist");
		const stages = join(dist, "startup-stages");
		const { stages: count } = JSON.parse(fs.readFileSync(join(stages, "stages.json"), "utf8")) as { stages: number };
		assert.ok(count > 1, "the package loads its modules in stages");
		const loaded = staticallyLoaded(dist, cliImports(dist));
		const imported: string[] = [];
		for (let index = 0; index < count; index++) {
			assert.ok(paths.has(`dist/startup-stages/${index}.js`), `stage ${index} is packed`);
			for (const match of codeOf(join(stages, `${index}.js`)).matchAll(/\bimport\s*"(\.\.\/[^"]+)"/g))
				imported.push(posix.normalize(posix.join("startup-stages", match[1] as string)));
		}
		assert.ok(imported.includes("main.js"), "the stages load main.js");
		assert.deepEqual(
			imported.filter((file) => !loaded.has(file)),
			[],
			"every file a stage imports is one the CLI's imports load",
		);
	},
	PACK_TIMEOUT_MS,
);

test(
	"the packed tarball carries only the 8 undici restart-notice shims without bundleDependencies or workspace mutations",
	() => {
		const { copy, tarball } = packedPackage();
		const list = spawnSyncCollect(["tar", "-tzf", basename(tarball)], {
			cwd: dirname(tarball),
			timeout: PACK_TIMEOUT_MS,
		});
		assert.equal(list.exitCode, 0, list.stderr.toString());
		const tarEntries = list.stdout.toString().trim().split(/\r?\n/);
		const bundledUndici = tarEntries.filter((entry) => entry.startsWith("package/node_modules/")).sort();
		assert.deepEqual(
			bundledUndici,
			undiciTombstoneEntries()
				.map((entry) => `package/${entry.path}`)
				.sort(),
		);
		const packedManifestRaw = spawnSyncCollect(["tar", "-xOf", basename(tarball), "package/package.json"], {
			cwd: dirname(tarball),
			timeout: PACK_TIMEOUT_MS,
		});
		assert.equal(packedManifestRaw.exitCode, 0, packedManifestRaw.stderr.toString());
		const packedManifest = JSON.parse(packedManifestRaw.stdout.toString()) as {
			optionalDependencies?: Record<string, string>;
			bundleDependencies?: string[];
		};
		assert.equal(packedManifest.optionalDependencies?.undici, undefined);
		assert.equal(packedManifest.bundleDependencies, undefined);
		assert.equal(fs.existsSync(join(copy, "node_modules", "undici")), false);
	},
	PACK_TIMEOUT_MS,
);
