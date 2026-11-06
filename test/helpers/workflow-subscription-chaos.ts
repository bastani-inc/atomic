import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileExists, moduleDir, readText, type SpawnedProcess, sleep, spawnSyncCollect } from "./runtime.js";

export const ROOT = resolve(moduleDir(import.meta.url), "../..");
export const FIXTURE = join(ROOT, "test/fixtures/workflow-subscription-chaos.ts");
export const COMMAND = [process.execPath, "--import", "jiti/register", FIXTURE];
export const EVENTS = 60;
export const MAX_CONCURRENT = 4;
export const HANDLER_DELAY_MS = "25";
/** Structural: each scenario starts, faults and restarts real Node processes on a SQLite journal. */
export const CHAOS_SCENARIO_TIMEOUT_MS = 240_000;
export const PROCESS_PHASE_TIMEOUT_MS = 90_000;

export type Handled = ReadonlyMap<string, readonly string[]>;

export async function handledByLabel(directory: string): Promise<Handled> {
	const path = join(directory, "handled.txt");
	const lines = (await fileExists(path)) ? (await readText(path)).trim().split("\n").filter(Boolean) : [];
	const byLabel = new Map<string, string[]>();
	for (const line of lines) {
		const [label, id] = line.split(" ") as [string, string];
		byLabel.set(label, [...(byLabel.get(label) ?? []), id]);
	}
	return byLabel;
}

export async function waitForHandled(directory: string, label: string, count: number): Promise<void> {
	const deadline = Date.now() + PROCESS_PHASE_TIMEOUT_MS;
	while (((await handledByLabel(directory)).get(label)?.length ?? 0) < count) {
		assert.ok(Date.now() < deadline, `${label} handled fewer than ${count} events`);
		await sleep(10);
	}
}

export function fixture(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
	return spawnSyncCollect([...COMMAND, ...args], { cwd: ROOT, env, timeout: PROCESS_PHASE_TIMEOUT_MS });
}

export function lastJson<T>(output: Uint8Array | string): T {
	return JSON.parse(output.toString().trim().split("\n").at(-1)!) as T;
}

/** The main `chaos` subscription plus two whose event children shared names under the old naming. */
export const SUBSCRIPTIONS = 3;
export const OTHER_SUBSCRIPTIONS_DONE = { chaos2: EVENTS, "chaos2/x": EVENTS };

export interface Records {
	readonly processed: string[];
	readonly eventRecords: number;
	readonly others: Record<string, number>;
	/** The subscriber's persisted conversation: its prompt, then one message per delivered report. */
	readonly watcherMessages: string[] | null;
}

export function records(directory: string, runId: string): Records {
	const result = fixture(["records", directory, runId, "inspector"]);
	assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
	return lastJson(result.stdout);
}

export function integrity(directory: string): string {
	const database = new DatabaseSync(join(directory, "journal.sqlite"), { readOnly: true });
	try {
		return String((database.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check);
	} finally {
		database.close();
	}
}

export const allIds = Array.from({ length: EVENTS }, (_, index) => `e${index}`);
/** Every tenth event of the `chaos` subscription matters, and its child reports it to the watcher. */
export const RELEVANT_IDS = allIds.filter((_id, index) => index % 10 === 0);
export const WATCHER_PROMPT = "Watch the chaos events and act on reports.";

export async function lines(directory: string, file: string): Promise<string[]> {
	const path = join(directory, file);
	return (await fileExists(path)) ? (await readText(path)).trim().split("\n").filter(Boolean) : [];
}

/** Every event child that ran, also after a resume or a takeover, was seeded with its own subscription and event. */
export async function assertEveryChildSeeded(directory: string, labels: readonly string[]): Promise<void> {
	const seeded = (await lines(directory, "prompts.txt")).filter((line) => labels.includes(line.split(" ")[0]!));
	assert.ok(seeded.length >= EVENTS * SUBSCRIPTIONS, `only ${seeded.length} event children ran`);
	for (const line of seeded) {
		const [label, stage, seed] = line.split(" ") as [string, string, string];
		const keyEnd = stage.lastIndexOf("#");
		const own = `${stage.slice(0, keyEnd)}:${decodeURIComponent(stage.slice(stage.indexOf("/", keyEnd) + 1))}`;
		assert.equal(seed, own, `${label} ran ${stage} without its own seed`);
	}
}

/**
 * Every relevant event reached the subscriber at least once and nothing else did. `failovers` bounds the repeats:
 * only a report sent by a child that was still running when its owner stopped can arrive again.
 */
export async function assertReports(
	directory: string,
	labels: readonly string[],
	watcherMessages: string[] | null,
	failovers: number,
): Promise<void> {
	const reported = (await lines(directory, "reports.txt"))
		.map((line) => line.split(" ") as [string, string])
		.filter(([label]) => labels.includes(label))
		.map(([, id]) => id);
	const maxRepeats = failovers * MAX_CONCURRENT;
	assert.deepEqual([...new Set(reported)].sort(), [...RELEVANT_IDS].sort());
	assert.ok(reported.length <= RELEVANT_IDS.length + maxRepeats, `${reported.length} reports`);
	assert.ok(watcherMessages !== null, "the watcher stage has no recorded session");
	const [prompt, ...grown] = watcherMessages;
	assert.equal(prompt, WATCHER_PROMPT);
	const delivered = grown.map((message) => {
		const match = /^Report from event child "chaos#1\/(e\d+)" \(event (e\d+)\):\n\nevent (e\d+) matters$/.exec(
			message,
		);
		assert.ok(match !== null && match[1] === match[2] && match[2] === match[3], `not a report: ${message}`);
		return match[1]!;
	});
	assert.deepEqual([...new Set(delivered)].sort(), [...RELEVANT_IDS].sort());
	assert.ok(delivered.length <= RELEVANT_IDS.length + maxRepeats, `${delivered.length} messages in the watcher`);
}

/** SQLite's primary result code for a lock held by another connection. */
export const SQLITE_BUSY = 5;
/** Bound on SIGSTOP retries: the owner holds the write lock for milliseconds between handler completions. */
export const STOP_ATTEMPTS = 200;

export function writeLockFree(path: string): boolean {
	const database = new DatabaseSync(path);
	try {
		database.exec("PRAGMA busy_timeout=0");
		database.exec("BEGIN IMMEDIATE");
		database.exec("ROLLBACK");
		return true;
	} catch (error) {
		if ((error as { errcode?: number }).errcode === SQLITE_BUSY) return false;
		throw error;
	} finally {
		database.close();
	}
}

/** The run journal and the store the scripted event children keep their sessions in. */
export async function storageWriteLocksFree(directory: string): Promise<boolean> {
	for (const path of [join(directory, "journal.sqlite"), join(directory, "workflows", "journal.sqlite")]) {
		if ((await fileExists(path)) && !writeLockFree(path)) return false;
	}
	return true;
}

/**
 * Stops `owner` at a moment it holds no write lock on the journal or the session store. A journal transaction waits
 * out a stopped lock holder for minutes by design, so stopping the owner mid-transaction would only test SQLite's lock
 * wait.
 */
export async function stopOutsideTransaction(owner: SpawnedProcess, directory: string): Promise<void> {
	for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt++) {
		owner.kill("SIGSTOP");
		if (await storageWriteLocksFree(directory)) return;
		owner.kill("SIGCONT");
		await sleep(5);
	}
	assert.fail(`the owner held a storage write lock at each of ${STOP_ATTEMPTS} stops`);
}
