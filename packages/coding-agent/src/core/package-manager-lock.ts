import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { APP_NAME } from "../config.js";

/** A holder that stops refreshing its lock (a killed process) loses it after this long. */
const INSTALL_LOCK_STALE_MS = 60_000;
/** About ten minutes of polling for another process's install of the same package to finish. */
const INSTALL_LOCK_RETRIES = { retries: 600, minTimeout: 100, maxTimeout: 1_000, factor: 1.2 };

/**
 * Runs `operation` while holding the cross-process install lock of `installPath`, so concurrent processes
 * install, update, or remove one package one at a time. The lock is a sibling directory of `installPath`.
 */
export async function withInstallLock<T>(installPath: string, operation: () => Promise<T>): Promise<T> {
	const parent = dirname(installPath);
	mkdirSync(parent, { recursive: true });
	const release = await lockfile.lock(installPath, {
		realpath: false,
		lockfilePath: join(parent, `.${basename(installPath)}.${APP_NAME}-install.lock`),
		stale: INSTALL_LOCK_STALE_MS,
		retries: INSTALL_LOCK_RETRIES,
		// The install itself never deletes a directory it did not create, so a lock lost to a stall is not fatal.
		onCompromised: () => {},
	});
	try {
		return await operation();
	} finally {
		await release().catch(() => {});
	}
}
