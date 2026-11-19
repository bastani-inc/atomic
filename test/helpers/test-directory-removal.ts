import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface RemovalRetries {
	readonly retries: number;
	readonly retryDelayMs: number;
}

const HELD_CODES = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);

function isHeld(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === undefined) return false;
	return HELD_CODES.has(code) || (process.platform === "win32" && code === "EACCES");
}

function leftoverRecords(runDirectory: string): string {
	return join(runDirectory, "leftover-test-directories");
}

function recordLeftover(path: string): string | undefined {
	const runDirectory = process.env.ATOMIC_TEST_RUN_DIR;
	if (runDirectory === undefined) return undefined;
	const records = leftoverRecords(runDirectory);
	mkdirSync(records, { recursive: true });
	const record = join(records, randomUUID());
	writeFileSync(record, path);
	return record;
}

async function removeWhenLetGo(path: string, { retries, retryDelayMs }: RemovalRetries): Promise<boolean> {
	for (let attempt = 1; attempt <= retries; attempt++) {
		await delay(attempt * retryDelayMs, undefined, { ref: false });
		try {
			await rm(path, { recursive: true, force: true });
			return true;
		} catch (error) {
			if (!isHeld(error)) return false;
		}
	}
	return false;
}

export function removeTestDirectory(path: string, retries: RemovalRetries): void {
	try {
		rmSync(path, { recursive: true, force: true });
		return;
	} catch (error) {
		if (!isHeld(error)) throw error;
	}
	const record = recordLeftover(path);
	void removeWhenLetGo(path, retries).then((removed) => {
		if (removed && record !== undefined) rmSync(record, { force: true });
	});
}

export async function removeLeftoverTestDirectories(runDirectory: string, retries: RemovalRetries): Promise<string[]> {
	const records = leftoverRecords(runDirectory);
	let names: string[];
	try {
		names = readdirSync(records);
	} catch {
		return [];
	}
	const kept: string[] = [];
	await Promise.all(
		names.map(async (name) => {
			let path: string;
			try {
				path = readFileSync(join(records, name), "utf8");
			} catch {
				return;
			}
			try {
				await rm(path, {
					recursive: true,
					force: true,
					maxRetries: retries.retries,
					retryDelay: retries.retryDelayMs,
				});
				rmSync(join(records, name), { force: true });
			} catch {
				kept.push(path);
			}
		}),
	);
	return kept;
}
