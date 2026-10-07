import { existsSync } from "node:fs";
import { readTextSync } from "./runtime.js";

function isErrnoAt(error: Error, code: string, path: string): boolean {
	return "code" in error && error.code === code && "path" in error && error.path === path;
}

/** Observe the captured server only; its replacement may already have a pidfile. */
export function postmasterIdentityChanged(pidfile: string, expected: { pid: number; started: number }): boolean {
	let identity: string[];
	try {
		// One read avoids exists/stat/read races as PostgreSQL removes its pidfile.
		identity = readTextSync(pidfile, "utf8").split(/\r?\n/);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		if (isErrnoAt(error, "ENOENT", pidfile)) return true;
		// Windows refuses to open a pidfile PostgreSQL has deleted while a handle
		// is still open; it disappears once that handle closes.
		if (process.platform === "win32" && isErrnoAt(error, "EPERM", pidfile) && !existsSync(pidfile)) return false;
		throw error;
	}
	const pid = Number(identity[0]);
	const started = Number(identity[2]);
	return (
		Number.isSafeInteger(pid) &&
		pid > 0 &&
		Number.isSafeInteger(started) &&
		started > 0 &&
		(pid !== expected.pid || started !== expected.started)
	);
}
