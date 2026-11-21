/**
 * Reads the files an interactive session's startup loads, many at once, so that a cold start does not wait for each
 * file in turn: an antivirus scans a file when it is first opened, and the module loader opens one file at a time.
 * Runs as a short-lived process of its own (see `startup-prefetch.ts`), started with the list
 * `scripts/write-startup-files.mjs` wrote and Atomic's package directory. It only reads: what it reads is discarded,
 * and a file it cannot find or read is skipped.
 *
 * Imports nothing but Node's own modules, so starting it reads no file of Atomic's but itself.
 */
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Reads in flight at once: as many as the I/O pool the process that started this one gave it. */
const READ_CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.UV_THREADPOOL_SIZE) || 32));

/** The largest file read: Atomic's native addon is the largest file startup loads, at about 20 MB. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * The startup file list: each package as its name and the package it is imported from (the index of an earlier one, or
 * -1 for Atomic's own), and each file as the index of its package and its path inside it.
 */
interface StartupFileList {
	readonly version: 2;
	/** Atomic's own package, which is `packageDir`. */
	readonly self: string;
	readonly packages: readonly (readonly [string, number])[];
	readonly files: readonly (readonly [number, string])[];
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The `node_modules` directory Atomic's own package is installed in: the reader looks for no package above it. In a
 * source checkout, which is in none, it looks up to the home directory, never in it or above.
 */
function installationRoot(packageDir: string): string | undefined {
	for (let dir = packageDir; dirname(dir) !== dir; dir = dirname(dir))
		if (basename(dir) === "node_modules") return dir;
	return undefined;
}

/**
 * Where a package is installed, as Node finds it from a module in `fromDir`: in the `node_modules` directories from
 * `fromDir` up, but none above the installation's own (`limit`), nor the home directory or above it. A package found
 * nowhere there is not read.
 */
async function packageRoot(name: string, fromDir: string, limit: string | undefined): Promise<string | undefined> {
	const home = homedir();
	for (let dir = fromDir; dir !== home && dirname(dir) !== dir; dir = dirname(dir)) {
		// A `node_modules` directory holds packages itself; Node does not look in one inside it.
		const candidate = basename(dir) === "node_modules" ? join(dir, name) : join(dir, "node_modules", name);
		if (await isDirectory(candidate)) return candidate;
		if (dir === limit) return undefined;
	}
	return undefined;
}

/** The native addon packages startup loads, with the name of their binaries (`<name>.<build>.node`). */
const NATIVE_ADDON_PACKAGES = new Map([["@bastani/atomic-natives", "atomic_natives"]]);

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/**
 * The build of a native addon that Node loads here, as the addon's own loader (`native/index.js`) picks it on Windows,
 * the only platform the reader runs on: `win32-<arch>-msvc`, or `-gnu` for an x64 Node built as a shared library.
 */
function windowsNativeBuild(): string | undefined {
	if (process.platform !== "win32") return undefined;
	const variables = (process.config as { variables?: { shlib_suffix?: string; node_target_type?: string } }).variables;
	const gnu =
		process.arch === "x64" &&
		(variables?.shlib_suffix === "dll.a" || variables?.node_target_type === "shared_library");
	return `win32-${process.arch}-${gnu ? "gnu" : "msvc"}`;
}

/**
 * The one binary of a native addon that Node loads here, as its loader looks for it: the package's own build for this
 * platform, else the platform package beside it. A package can ship the builds of every platform; the others are never
 * loaded, and are not read.
 */
async function nativeAddonFiles(
	name: string,
	binary: string,
	root: string,
	limit: string | undefined,
): Promise<string[]> {
	const build = windowsNativeBuild();
	if (build === undefined) return [];
	const own = join(root, "native", `${binary}.${build}.node`);
	if (await isFile(own)) return [own];
	const platformPackage = await packageRoot(`${name}-${build}`, root, limit);
	if (platformPackage === undefined) return [];
	const manifest = JSON.parse(await readFile(join(platformPackage, "package.json"), "utf8").catch(() => "{}")) as {
		main?: unknown;
	};
	const main = typeof manifest.main === "string" ? manifest.main : `${binary}.${build}.node`;
	// A file inside the platform package only.
	if (isAbsolute(main) || main.split(/[\\/]/).includes("..")) return [];
	return [join(platformPackage, main)];
}

export async function readStartupFiles(listPath: string, packageDir: string): Promise<number> {
	const list = JSON.parse(await readFile(listPath, "utf8")) as StartupFileList;
	if (list.version !== 2) return 0;
	const limit = installationRoot(packageDir);
	// Each package from the package it is imported from, as Node resolves it there: an earlier one in the list.
	const roots: (string | undefined)[] = [];
	for (const [index, [name, from]] of list.packages.entries()) {
		const fromDir = from >= 0 && from < index ? roots[from] : packageDir;
		roots.push(
			name === list.self && from < 0
				? packageDir
				: fromDir === undefined
					? undefined
					: await packageRoot(name, fromDir, limit),
		);
	}
	const paths: string[] = [];
	for (const [index, path] of list.files) {
		const root = roots[index];
		// A path inside its package only: the list never names one above it.
		if (root === undefined || isAbsolute(path) || path.split(/[\\/]/).includes("..")) continue;
		paths.push(join(root, path));
	}
	for (const [index, [name]] of list.packages.entries()) {
		const root = roots[index];
		const binary = NATIVE_ADDON_PACKAGES.get(name);
		if (root !== undefined && binary !== undefined)
			paths.push(...(await nativeAddonFiles(name, binary, root, limit)));
	}
	let next = 0;
	let read = 0;
	const reader = async () => {
		while (next < paths.length) {
			const path = paths[next++]!;
			try {
				// A regular file of a bounded size only, never a FIFO or device a different install could name.
				const stats = await stat(path);
				if (!stats.isFile() || stats.size > MAX_FILE_BYTES) continue;
				await readFile(path);
				read++;
			} catch {
				// Not installed here, or not readable: the module loader reports it if it ever needs it.
			}
		}
	};
	await Promise.all(Array.from({ length: READ_CONCURRENCY }, reader));
	return read;
}

/** Whether this module is the process's entry script, as the runtime resolved it: through any symbolic link. */
function isEntry(script: string | undefined): boolean {
	try {
		return script !== undefined && realpathSync(resolve(script)) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
}

// Started as a process's entry: `<runtime> startup-prefetch-reader.js <list> <packageDir>`.
const [entry, listPath, packageDir] = process.argv.slice(1);
if (isEntry(entry) && listPath && packageDir) {
	// The process that started this one holds the other end of standard input: when it ends, however it ends, so does
	// this reader.
	process.stdin.on("end", () => process.exit(0));
	process.stdin.on("close", () => process.exit(0));
	process.stdin.on("error", () => process.exit(0));
	process.stdin.resume();
	void readStartupFiles(listPath, packageDir).then(
		() => process.exit(0),
		() => process.exit(0),
	);
}
