// @ts-check
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { attachCleanupFailure, DistributedProvisionError, isCancellation, isDistributedTestError } from "./errors.mjs";

/**
 * @param {string} path
 * @param {(temporary: string) => Promise<void>} produce
 * @returns {Promise<boolean>}
 */
export async function cacheFile(path, produce) {
	if (existsSync(path)) return true;
	let staging;
	let failure;
	let cached = false;
	try {
		mkdirSync(dirname(path), { recursive: true });
		staging = mkdtempSync(join(dirname(path), `.${basename(path)}-`));
		const temporary = join(staging, "entry");
		await produce(temporary);
		try {
			linkSync(temporary, path);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") cached = true;
			else throw error;
		}
	} catch (error) {
		failure =
			isCancellation(error) || isDistributedTestError(error)
				? error
				: new DistributedProvisionError({
						step: "publish cache entry",
						resource: basename(path),
						cause: error,
					});
	}
	if (staging !== undefined) {
		try {
			rmSync(staging, { recursive: true, force: true });
		} catch (cause) {
			const cleanup = new DistributedProvisionError({
				step: "remove cache staging",
				resource: basename(path),
				cause,
			});
			if (failure === undefined) failure = cleanup;
			else attachCleanupFailure(failure, cleanup);
		}
	}
	if (failure !== undefined) throw failure;
	return cached;
}
