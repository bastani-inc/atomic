// Removes an open-lock file while holding its exclusive lock, and takes its shared lock, over and over until
// `durationMs` has passed, as connections opening and retiring one SQLite file do; prints what each refusal said.
import { rm } from "node:fs/promises";
import { tryAdvisoryLockAsync, trySharedAdvisoryLock } from "@bastani/atomic-natives";

const [lockPath, durationMs] = process.argv.slice(2);
const until = Date.now() + Number(durationMs);
const refusals = {};
let removals = 0;
let sharedLocks = 0;

function refused(error) {
	const message = error instanceof Error ? error.message : String(error);
	refusals[message] = (refusals[message] ?? 0) + 1;
}

async function remove() {
	while (Date.now() < until) {
		try {
			const exclusive = await tryAdvisoryLockAsync(lockPath, 0);
			if (exclusive === null) {
				await new Promise((resolve) => setImmediate(resolve));
				continue;
			}
			try {
				await rm(lockPath, { force: true });
				removals++;
			} finally {
				exclusive.release();
			}
		} catch (error) {
			refused(error);
		}
	}
}

async function share() {
	while (Date.now() < until) {
		try {
			const shared = trySharedAdvisoryLock(lockPath, 0);
			if (shared !== null) {
				sharedLocks++;
				shared.release();
			}
		} catch (error) {
			refused(error);
		}
		await new Promise((resolve) => setImmediate(resolve));
	}
}

await Promise.all([remove(), share()]);
process.stdout.write(`${JSON.stringify({ removals, sharedLocks, refusals })}\n`);
