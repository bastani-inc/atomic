"use strict";
const { renameSync, statSync } = require("node:fs");

/** Transient Windows error codes when another process, thread, or scanner briefly holds a path open. */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/** How long a refused directory rename is retried on Windows, matching graceful-fs (60 s). */
const RENAME_RETRY_DIRECTORY_MS = 60_000;
/** How long a refused file rename is retried on Windows. */
const RENAME_RETRY_FILE_MS = 10_000;
/** Initial backoff before retrying a refused rename; grows by this step up to the cap. */
const RENAME_RETRY_BACKOFF_START_MS = 10;
const RENAME_RETRY_BACKOFF_MAX_MS = 100;

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function defaultSleepSync(ms) {
	Atomics.wait(sleeper, 0, 0, ms);
}

function isDirectorySync(path, stat) {
	try {
		return stat(path).isDirectory();
	} catch {
		return false;
	}
}

function existsSyncWith(path, stat) {
	try {
		stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Synchronously renames `from` to `to`, modelled on graceful-fs: on Windows, transient EPERM/EACCES/EBUSY failures
 * from another process's handle, a scanner, or a just-ended child are retried with a growing backoff (10 ms up to
 * 100 ms) until the rename succeeds or `budgetMs` is spent (60 s for directories, 10 s for files). Moving a directory
 * onto an existing directory (other than a case-only rename of the same path), any other error code, and any error off
 * Windows throw immediately. Returns the number of attempts made.
 */
function renameSyncWithRetry(from, to, options = {}) {
	const platform = options.platform ?? process.platform;
	const rename = options.rename ?? renameSync;
	const stat = options.stat ?? statSync;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleepSync;
	if (platform !== "win32") {
		rename(from, to);
		return 1;
	}
	const started = now();
	let backoff = RENAME_RETRY_BACKOFF_START_MS;
	let directory;
	const caseOnly = from.toLowerCase() === to.toLowerCase();
	for (let attempt = 1; ; attempt++) {
		try {
			rename(from, to);
			return attempt;
		} catch (error) {
			const code = error && typeof error === "object" ? error.code : undefined;
			if (typeof code !== "string" || !TRANSIENT_RENAME_CODES.has(code)) throw error;
			if (directory === undefined) directory = isDirectorySync(from, stat);
			const budget = options.budgetMs ?? (directory ? RENAME_RETRY_DIRECTORY_MS : RENAME_RETRY_FILE_MS);
			if (now() - started + backoff > budget) throw error;
			if (directory && !caseOnly && existsSyncWith(to, stat)) throw error;
			sleep(backoff);
			backoff = Math.min(backoff + RENAME_RETRY_BACKOFF_START_MS, RENAME_RETRY_BACKOFF_MAX_MS);
		}
	}
}

module.exports = {
	RENAME_RETRY_BACKOFF_MAX_MS,
	RENAME_RETRY_BACKOFF_START_MS,
	RENAME_RETRY_DIRECTORY_MS,
	RENAME_RETRY_FILE_MS,
	renameSyncWithRetry,
};
