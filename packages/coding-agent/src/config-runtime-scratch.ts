import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, type Stats, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { getRuntimeScratchCache, reportRuntimeStorageFallback } from "./config.js";
import {
	assertPrivateDirectoryAsync,
	createFallbackRun,
	createFallbackRunAsync,
	ensureAgentScratchParent,
	ensureAgentScratchParentAsync,
	fallbackRunParents,
} from "./core/tools/session-temp-dir.ts";

import { isPathInside } from "./utils/path-inside.ts";
import { resolvePhysicalPathAsync } from "./utils/physical-path.ts";

/** A snapshot must not create even an empty agent directory in the checkout it is observing. */
export async function checkoutScratchCache(
	cache: string,
	checkout: { readonly root: string; readonly gitDir?: string },
): Promise<string> {
	const physical = await realpath(cache)
		.catch(() => resolvePhysicalPathAsync(cache))
		.catch(() => undefined);
	if (physical !== undefined && !isPathInside(checkout.root, physical)) return cache;
	return getRuntimeScratchCache(join(checkout.gitDir ?? join(checkout.root, ".git"), "atomic-runtime"));
}

// A shared home can contain runs from other hosts. Only this host can interpret its PIDs.
function hostPrefix(): string {
	return `${createHash("sha256").update(hostname()).digest("hex").slice(0, 12)}-`;
}
function runPrefix(): string {
	return `${hostPrefix()}${process.pid}-`;
}
const directories = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const owned = new Map<string, Stats>();
let suffix: string | undefined;
let exitRegistered = false;

/** Path-only resolution lets a session name its spill directory before a tool needs to write. */
export function plannedRuntimeScratchDir(cache = getRuntimeScratchCache()): string {
	return directories.get(cache) ?? preferredRuntimeScratchDir(cache);
}
export function preferredRuntimeScratchDir(cache = getRuntimeScratchCache()): string {
	suffix ??= `${runPrefix()}${randomBytes(6).toString("hex")}`;
	return join(cache, "tmp", "runs", suffix);
}

/** An unambiguous ESRCH proves that the process is gone; uncertainty preserves its files. */
function isDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
	return false;
}

// Exclude even the marker itself when an agent directory is inside a Git checkout. On Linux a PID only has
// meaning in its own namespace. A process unable to identify its namespace does not sweep.
function marker(namespace: string): string {
	return `*\n# Atomic runtime: ${process.platform} ${namespace}\n`;
}
function ownNamespace(): Promise<string> {
	return process.platform === "linux" ? readlink("/proc/self/ns/pid") : Promise.resolve("");
}
function ownNamespaceSync(): string {
	return process.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : "";
}

/** Reap only known runs on this host, never following an entry or sweeping another account's root. */
export async function sweepRuntimeScratch(): Promise<void> {
	const primary = join(getRuntimeScratchCache(), "tmp", "runs");
	const parents = new Set([
		primary,
		...fallbackRunParents(),
		...[...owned.keys()].map((dir) => dirname(dir)).filter((dir) => basename(dir) === "runs"),
	]);
	const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
	const prefix = hostPrefix();
	const expected = marker(await ownNamespace());
	for (const parent of parents) {
		try {
			await assertPrivateDirectoryAsync(dirname(parent));
			await assertPrivateDirectoryAsync(parent);
			for (const entry of await readdir(parent, { withFileTypes: true })) {
				if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
				const match = /^([1-9]\d{0,9})-(?:[a-f0-9]{12}|[a-zA-Z0-9]{6})$/.exec(entry.name.slice(prefix.length));
				if (!match) continue;
				const path = join(parent, entry.name);
				try {
					const stat = await lstat(path);
					if (!stat.isDirectory() || stat.mtimeMs >= cutoff || !isDead(Number(match[1]))) continue;
					await assertPrivateDirectoryAsync(path);
					const file = join(path, ".gitignore");
					const info = await lstat(file);
					if (
						info.isFile() &&
						info.size === Buffer.byteLength(expected) &&
						(await readFile(file, "utf8")) === expected
					) {
						await rm(path, { recursive: true, force: true });
					}
				} catch {
					/* A concurrent sweep or a refused entry does not block the rest. */
				}
			}
		} catch {
			/* No private tree to collect. */
		}
	}
}

function isOwnedDir(path: string, stat: Stats): boolean {
	const known = owned.get(path);
	return (
		!!known &&
		stat.isDirectory() &&
		stat.dev === known.dev &&
		stat.ino === known.ino &&
		stat.birthtimeMs === known.birthtimeMs &&
		(process.platform === "win32" || (stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0))
	);
}
function cleanOwnScratch(): void {
	for (const path of owned.keys()) {
		try {
			if (isOwnedDir(path, lstatSync(path))) rmSync(path, { recursive: true, force: true });
		} catch {
			/* Retry on a later startup. */
		}
	}
}
function remember(key: string, dir: string, stat: Stats): string {
	if (!exitRegistered) {
		process.once("exit", cleanOwnScratch);
		exitRegistered = true;
	}
	if (!directories.has(key))
		setTimeout(() => {
			void sweepRuntimeScratch().catch(() => {});
		}, 10_000).unref();
	owned.set(dir, stat);
	// A synchronous caller can finish while an asynchronous allocation is in flight. Both use the first published tree.
	const canonical = directories.get(key) ?? dir;
	directories.set(key, canonical);
	return canonical;
}

/** Release only an actual run of this process, never a path that was merely planned. */
export async function removeRunSession(cache: string, name: string): Promise<void> {
	const dir = directories.get(cache);
	if (!dir) return;
	try {
		if (!isOwnedDir(dir, await lstat(dir))) return;
		const sessions = join(dir, "sessions");
		await assertPrivateDirectoryAsync(sessions);
		await rm(join(sessions, name), { recursive: true, force: true });
	} catch {
		/* A session need not have spilled anything. */
	}
}

async function createRunDirectory(cache: string): Promise<string> {
	let dir = directories.get(cache);
	if (dir) {
		try {
			if (isOwnedDir(dir, await lstat(dir))) return dir;
		} catch {
			/* Recreate a removed directory. */
		}
		directories.delete(cache);
	}
	let created: string | undefined;
	const initialize = async (path: string) => {
		created = path;
		await writeFile(join(path, ".gitignore"), marker(await ownNamespace().catch(() => "unverified")), {
			flag: "wx",
			mode: 0o600,
		});
		return remember(cache, path, await lstat(path));
	};
	try {
		dir = preferredRuntimeScratchDir(cache);
		await ensureAgentScratchParentAsync(cache);
		const alreadyCreated = directories.get(cache);
		if (alreadyCreated) return alreadyCreated;
		await mkdir(dir, { mode: 0o700 });
		return await initialize(dir);
	} catch {
		if (created) await rm(created, { recursive: true, force: true }).catch(() => {});
		reportRuntimeStorageFallback();
		return initialize(await createFallbackRunAsync(runPrefix()));
	}
}

export function runtimeScratchDirectory(cache: string): Promise<string> {
	let creating = pending.get(cache);
	if (!creating) {
		creating = createRunDirectory(cache).finally(() => pending.delete(cache));
		pending.set(cache, creating);
	}
	return creating;
}

/** Only synchronous bootstrap and stream APIs need this variant. */
export function getRuntimeScratchDirSync(): string {
	const cache = getRuntimeScratchCache();
	const known = directories.get(cache);
	if (known) {
		try {
			if (isOwnedDir(known, lstatSync(known))) return known;
		} catch {
			/* Recreate a removed directory. */
		}
		directories.delete(cache);
	}
	const initialize = (dir: string) => {
		let namespace: string;
		try {
			namespace = ownNamespaceSync();
		} catch {
			namespace = "unverified";
		}
		try {
			writeFileSync(join(dir, ".gitignore"), marker(namespace), { flag: "wx", mode: 0o600 });
			return remember(cache, dir, lstatSync(dir));
		} catch (error) {
			rmSync(dir, { recursive: true, force: true });
			throw error;
		}
	};
	try {
		const parent = ensureAgentScratchParent(cache);
		if (pending.has(cache)) return initialize(mkdtempSync(join(parent, runPrefix())));
		const dir = preferredRuntimeScratchDir(cache);
		mkdirSync(dir, { mode: 0o700 });
		return initialize(dir);
	} catch {
		reportRuntimeStorageFallback();
		return initialize(createFallbackRun(runPrefix()));
	}
}
