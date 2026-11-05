/**
 * A process for the journal store consolidation chaos tests (#4325). `consolidate <store> [fence|copy|repoint]` moves the
 * finished runs of the store's adopted journals, and with a step it SIGKILLs itself there: right after it fenced a run,
 * after it copied it, or after it repointed the catalog. `read <store> <stop file> <events> <run>...` reads every given
 * run through the store over and over until the stop file exists, and prints how many reads were complete, how many
 * ended in the retryable `run-moved`, and how many were short or not dense, which must be none.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { consolidateJournalStore, isJournalCatalogError, JournalCatalog } from "@bastani/atomic/storage";
import { openSelectedRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";

const [mode, store, ...rest] = process.argv.slice(2);
assert.ok(mode && store);

if (mode === "consolidate") {
	const step = rest[0];
	const catalog = await JournalCatalog.open(store);
	const die = (): never => {
		process.kill(process.pid, "SIGKILL");
		throw new Error("unreachable");
	};
	if (step === "fence") Reflect.set(catalog, "homeShard", async () => die());
	if (step === "copy" || step === "repoint") {
		const moveRun = catalog.moveRun.bind(catalog);
		Reflect.set(catalog, "moveRun", async (runId: string, from: number, to: number) => {
			if (step === "copy") die();
			const moved = await moveRun(runId, from, to);
			return step === "repoint" ? die() : moved;
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
		await delay(5);
	}
	process.stdout.write(`${JSON.stringify({ complete, retried, truncated })}\n`);
}
