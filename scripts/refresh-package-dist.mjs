#!/usr/bin/env node
// Brings the dist directories of the packages Atomic depends on up to date without rewriting them in place, so tests
// and other processes that import those packages while `npm run build` or `npm run typecheck` runs never read a
// missing or half-written file.
//
// Usage: node scripts/refresh-package-dist.mjs <package-dir>...
//
// Each package is compiled with its own tsconfig.build.json into a staging directory next to dist, at the same depth so
// the source maps point at the same sources. Only files whose bytes differ are then moved into dist, each replacing the
// old file in one rename, so an up-to-date dist is left exactly as it was. Like the package build, files that are no
// longer emitted stay in dist, except under @bastani/atomic-ai's providers/data, which mirrors src/providers/data.
//
// A package with a `build:bundle` script is bundled from the staged files before anything moves (see
// bundle-package-dist.mjs), so its dist only ever holds bundled files, its `_modules` mirrors the staged one, and the
// shared files an earlier bundle wrote that this one did not are removed.
//
// Windows refuses to replace a file that another program has open. The rename is tried again while a reader finishes
// with the file; only a file still held after about two seconds is written in place, as the package build does.
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSharedFile } from "./bundle-package-dist.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Generated files copied into a package's dist beside what tsc emits. `from` is relative to the package, `to` to its
 * dist; `to` holds nothing else, so a file there that `from` no longer has is removed, as the package build's clean does.
 * @type {Record<string, { from: string, to: string, modelData?: boolean }>}
 */
const COPIED_OUTPUTS = {
	"packages/ai": { from: "src/providers/data", to: "providers/data", modelData: true },
};

/**
 * How long a refused rename is tried again: Windows refuses to replace a file while another program, such as a test
 * importing it or an antivirus scan, has it open, which is usually for moments. About two seconds.
 */
const RENAME_TRIES = 50;
const RENAME_RETRY_MS = 40;
const RETRIED_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** @param {string} directory @returns {string[]} the files under `directory`, relative to it, with `/` separators */
function listFiles(directory) {
	if (!existsSync(directory)) return [];
	/** @type {string[]} */
	const files = [];
	const visit = (/** @type {string} */ current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) visit(path);
			else files.push(relative(directory, path).split("\\").join("/"));
		}
	};
	visit(directory);
	return files.sort();
}

/**
 * Replaces `to` with `from` in one rename, so a reader sees the whole old file or the whole new one. A file another
 * program keeps open past the retries is written in place instead, as the package build always did.
 * @param {string} from
 * @param {string} to
 */
function replaceFile(from, to) {
	for (let attempt = 1; ; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? "";
			if (!RETRIED_RENAME_CODES.has(code)) throw error;
			if (attempt >= RENAME_TRIES) {
				writeFileSync(to, readFileSync(from));
				return;
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_MS);
		}
	}
}

/**
 * Moves each file of `staged` whose bytes differ from its counterpart in `dist` into place with one rename, keeping the
 * replaced file's mode, and removes the files under `dist/<prune>` that `staged` does not have.
 * @param {string} staged
 * @param {string} dist
 * @param {string[]} [prune] directories relative to dist that mirror the staged ones exactly
 * @returns {{ files: number, replaced: string[], removed: string[] }}
 */
export function moveChangedFiles(staged, dist, prune = []) {
	const files = listFiles(staged);
	/** @type {string[]} */
	const replaced = [];
	for (const file of files) {
		const from = join(staged, file);
		const to = join(dist, file);
		if (existsSync(to)) {
			if (readFileSync(from).equals(readFileSync(to))) continue;
			chmodSync(from, statSync(to).mode);
		} else {
			mkdirSync(dirname(to), { recursive: true });
		}
		replaceFile(from, to);
		replaced.push(file);
	}
	const emitted = new Set(files);
	/** @type {string[]} */
	const removed = [];
	for (const directory of prune) {
		for (const file of listFiles(join(dist, directory))) {
			const path = `${directory}/${file}`;
			if (emitted.has(path)) continue;
			unlinkSync(join(dist, path));
			removed.push(path);
		}
	}
	return { files: files.length, replaced, removed };
}

/** Runs a package.json script of the package in `cwd` through npm, as `npm run` would. @param {string} cwd @param {string} name */
function runScript(cwd, name, { quiet = false, args = /** @type {string[]} */ ([]) } = {}) {
	const result = spawnSync("npm", ["run", "--silent", name, ...(args.length > 0 ? ["--", ...args] : [])], {
		cwd,
		stdio: quiet ? "ignore" : "inherit",
		shell: process.platform === "win32",
	});
	return result.status === 0;
}

/** The generated model data is used as it is when it is valid, and generated again only when it is missing or stale. */
function ensureModelData(/** @type {string} */ packageDir) {
	if (runScript(packageDir, "check:model-data", { quiet: true })) return;
	console.log(`[refresh-dist] ${relative(root, packageDir)}: model data missing or stale, generating it`);
	if (!runScript(packageDir, "generate-models") || !runScript(packageDir, "check:model-data")) {
		throw new Error(`${relative(root, packageDir)}: could not generate the model data`);
	}
}

/**
 * @param {string} packageDir absolute
 * @param {{ generateModelData?: boolean, tsBuildInfoFile?: string }} [options] With `generateModelData: false`,
 *   @bastani/atomic-ai's model data is copied as it is, for a caller that has checked it, as the build does; by default
 *   missing or stale data is generated. `tsBuildInfoFile` keeps tsc's incremental state there between refreshes, so an
 *   unchanged program is not checked again; every file is still emitted into the staging directory.
 */
export function refreshPackageDist(packageDir, { generateModelData = true, tsBuildInfoFile } = {}) {
	const name = relative(root, packageDir).split("\\").join("/");
	const copied = COPIED_OUTPUTS[name];
	if (copied?.modelData && generateModelData) ensureModelData(packageDir);
	const staged = mkdtempSync(join(packageDir, ".dist-staging-"));
	/** Where a bundled package's staged dist is bundled (see below). */
	let bundleRoot;
	try {
		// The workspace's one TypeScript, the compiler every package build script runs.
		const manifest = createRequire(import.meta.url).resolve("typescript/package.json");
		const tsc = join(dirname(manifest), JSON.parse(readFileSync(manifest, "utf8")).bin.tsc);
		const incremental = tsBuildInfoFile === undefined ? [] : ["--incremental", "--tsBuildInfoFile", tsBuildInfoFile];
		const compiled = spawnSync(
			process.execPath,
			[tsc, "-p", "tsconfig.build.json", "--outDir", staged, ...incremental],
			{
				cwd: packageDir,
				stdio: "inherit",
			},
		);
		if (compiled.status !== 0) throw new Error(`${name}: tsc failed (${compiled.status ?? compiled.signal})`);
		if (copied) cpSync(join(packageDir, copied.from), join(staged, copied.to), { recursive: true });
		// A package that ships bundled (see bundle-package-dist.mjs) is bundled before anything moves into its dist. The
		// bundle names modules by their paths from the directory holding `dist`, so the staged files are bundled in a
		// directory named `dist`, one level down, which bundles them exactly as the package's own dist would be.
		let output = staged;
		const bundled = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).scripts?.["build:bundle"];
		if (bundled !== undefined) {
			bundleRoot = mkdtempSync(join(packageDir, ".bundle-staging-"));
			output = join(bundleRoot, "dist");
			renameSync(staged, output);
			if (!runScript(packageDir, "build:bundle", { args: [`--dist=${relative(packageDir, output)}`] })) {
				throw new Error(`${name}: bundling failed`);
			}
		}
		// The copy of a bundled package's modules for bundlers mirrors the compiled modules exactly.
		const prune = [...(copied ? [copied.to] : []), ...(bundled !== undefined ? ["_modules"] : [])];
		const dist = join(packageDir, "dist");
		const sharedFiles = new Set(readdirSync(output).filter(isSharedFile));
		const { files, replaced, removed } = moveChangedFiles(output, dist, prune);
		// A shared file an earlier bundle wrote that this one did not: nothing the package has now imports it.
		if (bundled !== undefined) {
			for (const file of readdirSync(dist)) {
				if (!isSharedFile(file) || sharedFiles.has(file)) continue;
				unlinkSync(join(dist, file));
				removed.push(file);
			}
		}
		console.log(
			`[refresh-dist] ${name}: ${replaced.length} of ${files} files changed${removed.length > 0 ? `, ${removed.length} removed` : ""}`,
		);
	} finally {
		rmSync(staged, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		if (bundleRoot !== undefined)
			rmSync(bundleRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const packages = process.argv.slice(2);
	if (packages.length === 0) {
		console.error("Usage: node scripts/refresh-package-dist.mjs <package-dir>...");
		process.exit(2);
	}
	try {
		for (const packageDir of packages) refreshPackageDist(resolve(root, packageDir));
	} catch (error) {
		console.error(`[refresh-dist] ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
