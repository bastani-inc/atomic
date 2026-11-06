/**
 * A process for the journal store consolidation chaos tests (#4325, #4402). `consolidate <store> [fence|copy|repoint]`
 * moves the finished runs of the store's adopted journals, and with a step it SIGKILLs itself there: right after it fenced
 * a run, after it copied it, or after it repointed the catalog.
 *
 * `consolidate <store> <barrier directory> <point>=<pause|kill>...` stops at named points of a move instead: `copied`
 * (its first copy of a run committed), `checked` (the catalog check of a move it abandons returned), `deleted` (a
 * deletion of a run's copy committed), `recopied` (its second copy committed), `repointing` (before it repoints the
 * catalog) and `undoing` (before it moves the catalog a second time). At `pause` it writes `<point>.reached` into the
 * barrier directory and blocks until `<point>.go` exists; at `kill` it SIGKILLs itself. Each point acts once.
 *
 * `read <store> <stop file> <events> <run>...` reads every given run through the store over and over until the stop
 * file exists. After each pass it prints how many reads so far were complete, how many ended in the retryable
 * `run-moved`, and how many were short or not dense, which must be none. Its first line counts its first pass, and its
 * last line every pass.
 */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { consolidateJournalStore, isJournalCatalogError, JournalCatalog } from "@bastani/atomic/storage";
import { openSelectedRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";

const [mode, store, ...rest] = process.argv.slice(2);
assert.ok(mode && store);

const die = (): never => {
	process.kill(process.pid, "SIGKILL");
	throw new Error("unreachable");
};

/** Stops at the named points of a move, from `<point>=<pause|kill>` arguments, each once. */
function failpoints(barrier: string, specs: readonly string[]): (point: string) => void {
	const actions = new Map(specs.map((spec) => spec.split("=") as [string, string]));
	const blocked = new Int32Array(new SharedArrayBuffer(4));
	return (point) => {
		const action = actions.get(point);
		if (action === undefined) return;
		actions.delete(point);
		if (action === "kill") die();
		writeFileSync(join(barrier, `${point}.reached`), "");
		while (!existsSync(join(barrier, `${point}.go`))) Atomics.wait(blocked, 0, 0, 10);
	};
}

/**
 * Reports the commits of a copy or a deletion of a run, at the first statement after them: the transaction has
 * released its write lock by then, and nothing else has run.
 */
function onCommittedWrites(reach: (point: string) => void): void {
	let writing: "copy" | "deletion" | undefined;
	let copies = 0;
	let committed: string | undefined;
	const fire = () => {
		const point = committed;
		committed = undefined;
		if (point !== undefined) reach(point);
	};
	const prepare = DatabaseSync.prototype.prepare;
	DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
		fire();
		if (sql.startsWith("INSERT INTO wf_runs(run_id, name")) writing = "copy";
		else if (sql.startsWith("DELETE FROM wf_runs WHERE")) writing = "deletion";
		return prepare.call(this, sql);
	} as typeof prepare;
	const exec = DatabaseSync.prototype.exec;
	DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
		fire();
		exec.call(this, sql);
		if (sql === "COMMIT" && writing !== undefined)
			committed = writing === "deletion" ? "deleted" : ++copies === 1 ? "copied" : "recopied";
		if (sql === "COMMIT" || sql === "ROLLBACK") writing = undefined;
	} as typeof exec;
}

if (mode === "consolidate") {
	const catalog = await JournalCatalog.open(store);
	const [step, ...specs] = rest;
	if (step === "fence") Reflect.set(catalog, "homeShard", async () => die());
	if (step === "copy" || step === "repoint") {
		const moveRun = catalog.moveRun.bind(catalog);
		Reflect.set(catalog, "moveRun", async (runId: string, from: number, to: number) => {
			if (step === "copy") die();
			const moved = await moveRun(runId, from, to);
			return step === "repoint" ? die() : moved;
		});
	}
	if (step !== undefined && specs.length > 0) {
		const reach = failpoints(step, specs);
		onCommittedWrites(reach);
		let moving = false;
		const homeShard = catalog.homeShard.bind(catalog);
		Reflect.set(catalog, "homeShard", async (runId: string) => {
			moving = true;
			return homeShard(runId);
		});
		const locate = catalog.locate.bind(catalog);
		Reflect.set(catalog, "locate", async (runId: string) => {
			const found = await locate(runId);
			if (moving) reach("checked");
			return found;
		});
		const moveRun = catalog.moveRun.bind(catalog);
		let moves = 0;
		Reflect.set(catalog, "moveRun", async (runId: string, from: number, to: number) => {
			reach(++moves === 1 ? "repointing" : "undoing");
			return moveRun(runId, from, to);
		});
	}
	const report = await consolidateJournalStore(catalog);
	await catalog.close();
	process.stdout.write(`${JSON.stringify({ moved: report.moved, skipped: report.skipped })}\n`);
} else {
	const [stopFile, eventsText, ...runIds] = rest;
	assert.ok(stopFile && eventsText && runIds.length > 0);
	const expected = Number(eventsText);
	let complete = 0;
	let retried = 0;
	let truncated = 0;
	while (!existsSync(stopFile)) {
		const journal = await openSelectedRunJournal({ kind: "sharded", dir: store }, dirname(store));
		try {
			for (const runId of runIds) {
				const seqs: number[] = [];
				try {
					for await (const entry of journal.read(runId)) seqs.push(entry.seq);
				} catch (error) {
					if (!isJournalCatalogError(error) || error.code !== "run-moved") throw error;
					retried++;
					continue;
				}
				if (seqs.length === expected && seqs.every((seq, index) => seq === index + 1)) complete++;
				else truncated++;
			}
		} finally {
			await journal.close();
		}
		process.stdout.write(`${JSON.stringify({ complete, retried, truncated })}\n`);
		await delay(5);
	}
}
