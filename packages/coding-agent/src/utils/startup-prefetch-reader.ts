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
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Reads in flight at once. */
const READ_CONCURRENCY = 32;

/** The largest file read: Atomic's native addon is the largest file startup loads, at about 20 MB. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** The startup file list: package names, and each file as the index of its package and its path inside it. */
interface StartupFileList {
	readonly version: 1;
	/** Atomic's own package, which is `packageDir`. */
	readonly self: string;
	readonly packages: readonly string[];
	readonly files: readonly (readonly [number, string])[];
}

/** The native addon packages whose platform builds ship as packages of their own beside them. */
const NATIVE_ADDON_PACKAGES = new Set(["@bastani/atomic-natives"]);

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** Where a package is installed as Node finds it from a module in `packageDir`: the nearest `node_modules` above. */
async function packageRoot(name: string, packageDir: string): Promise<string | undefined> {
	for (let dir = packageDir; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (await isDirectory(candidate)) return candidate;
		if (dirname(dir) === dir) return undefined;
	}
}

/** A native addon's `.node` files: in its own directory and in its installed platform packages beside it. */
async function nativeAddonFiles(name: string, root: string): Promise<string[]> {
	const files: string[] = [];
	const addNodeFiles = async (dir: string) => {
		for (const entry of await readdir(dir).catch(() => [] as string[]))
			if (entry.endsWith(".node")) files.push(join(dir, entry));
	};
	await addNodeFiles(join(root, "native"));
	await addNodeFiles(root);
	const scopeDir = dirname(root);
	const prefix = `${name.split("/").at(-1)}-`;
	for (const entry of await readdir(scopeDir).catch(() => [] as string[]))
		if (entry.startsWith(prefix)) await addNodeFiles(join(scopeDir, entry));
	return files;
}

export async function readStartupFiles(listPath: string, packageDir: string): Promise<number> {
	const list = JSON.parse(await readFile(listPath, "utf8")) as StartupFileList;
	if (list.version !== 1) return 0;
	const roots = await Promise.all(
		list.packages.map((name) => (name === list.self ? packageDir : packageRoot(name, packageDir))),
	);
	const paths: string[] = [];
	for (const [index, path] of list.files) {
		const root = roots[index];
		// A path inside its package only: the list never names one above it.
		if (root === undefined || isAbsolute(path) || path.split(/[\\/]/).includes("..")) continue;
		paths.push(join(root, path));
	}
	for (const [index, name] of list.packages.entries()) {
		const root = roots[index];
		if (root !== undefined && NATIVE_ADDON_PACKAGES.has(name)) paths.push(...(await nativeAddonFiles(name, root)));
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
