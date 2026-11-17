/**
 * Startup housekeeping for the subagent runtime temp root.
 *
 * The multi-level route/event pipeline that once wrote into this directory is
 * gone, so nothing creates entries here any more. The scanner stays because
 * users' machines still hold directories written by earlier versions, and
 * nothing else would ever reap them.
 */

import { lstat, readdir, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { LEGACY_TEMP_ROOT_DIR } from "../../../shared/types.js";

/**
 * Historical directory name. It must keep matching what earlier versions wrote,
 * or their leftovers become unreachable garbage.
 */
export const SUBAGENT_RUNTIME_TEMP_DIR = path.join(LEGACY_TEMP_ROOT_DIR, "nested-subagent-events");

/**
 * The legacy root sits at a fixed name in the shared temp directory, so it is
 * only scanned when it is a real directory this account owns and nobody else
 * can write to; otherwise its contents may not be ours to delete.
 */
async function isOwnUnsharedDirectory(dirPath: string): Promise<boolean> {
	try {
		const dirStat = await lstat(dirPath);
		if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return false;
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		if (uid !== undefined && dirStat.uid !== uid) return false;
		return process.platform === "win32" || (dirStat.mode & 0o022) === 0;
	} catch {
		return false;
	}
}

/** Whether any entry in the tree rooted at filePath has an mtime at or after cutoff, stopping at the first hit. */
export async function hasEntryNewerThan(filePath: string, cutoff: number): Promise<boolean> {
	const entryStat = await stat(filePath);
	if (entryStat.mtimeMs >= cutoff) return true;
	if (!entryStat.isDirectory()) return false;
	return directoryHasEntryNewerThan(filePath, cutoff);
}

async function directoryHasEntryNewerThan(dirPath: string, cutoff: number): Promise<boolean> {
	let entries: string[];
	try {
		entries = await readdir(dirPath);
	} catch {
		return false;
	}
	for (const entry of entries) {
		const childPath = path.join(dirPath, entry);
		try {
			const childStat = await stat(childPath);
			if (childStat.mtimeMs >= cutoff) return true;
			if (childStat.isDirectory() && (await directoryHasEntryNewerThan(childPath, cutoff))) return true;
		} catch {
			// Runtime cleanup is best-effort housekeeping.
		}
	}
	return false;
}

async function cleanupOldSubdirectories(root: string, maxAgeDays: number): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
	for (const entry of entries) {
		const entryPath = path.join(root, entry);
		try {
			if (!(await hasEntryNewerThan(entryPath, cutoff))) await rm(entryPath, { recursive: true, force: true });
		} catch {
			// Keep startup resilient if a child process removes or rewrites an entry while scanning.
		}
	}
}

export async function cleanupOldSubagentRuntimeDirs(maxAgeDays: number): Promise<void> {
	if (
		!(await isOwnUnsharedDirectory(LEGACY_TEMP_ROOT_DIR)) ||
		!(await isOwnUnsharedDirectory(SUBAGENT_RUNTIME_TEMP_DIR))
	)
		return;
	await cleanupOldSubdirectories(SUBAGENT_RUNTIME_TEMP_DIR, maxAgeDays);
}
