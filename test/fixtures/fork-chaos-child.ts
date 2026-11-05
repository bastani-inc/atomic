import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { isForkError } from "../../packages/workflows/src/durable/fork-errors.js";
import { forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";

/**
 * Forks a run in a SQLite journal file from a separate process, for the fork chaos tests. Prints one JSON line per
 * event: `claimed` once the source claim is taken, `copying` right before the single fork transaction, then one
 * `attempt` line per fork. Usage: fork-chaos-child.ts <path> <sourceRunId> <attempts> [fromStage] [skewMs]
 */
const [path, sourceRunId, attemptsText, fromStage, skewText] = process.argv.slice(2);
const skewMs = Number(skewText ?? "0");
if (skewMs !== 0) {
	const now = Date.now.bind(Date);
	Date.now = () => now() + skewMs;
}
const definition = workflow({ name: "chaos-source", description: "", inputs: {}, outputs: {}, run: async () => ({}) });
const journal = await openSqlRunJournal(path!);
const takeover = journal.takeoverExpired.bind(journal);
journal.takeoverExpired = async (runId, holderId, staleAfterMs) => {
	const outcome = await takeover(runId, holderId, staleAfterMs);
	if (outcome.status === "acquired" && holderId.startsWith("fork:")) console.log(JSON.stringify({ event: "claimed" }));
	return outcome;
};
const create = journal.createRunWithEvents.bind(journal);
journal.createRunWithEvents = async (header, events) => {
	console.log(JSON.stringify({ event: "copying", runId: header.runId, events: events.length }));
	return create(header, events);
};
const backend = await JournalDurableBackend.open(journal, { runs: [] });
const write = (line: object) => console.log(JSON.stringify(line));
try {
	for (let attempt = 0; attempt < Number(attemptsText ?? "1"); attempt++) {
		for (let tries = 0; tries < 1000; tries++) {
			try {
				const fork = await forkDurableRun(backend, {
					source: "sdk",
					runId: sourceRunId!,
					...(fromStage === undefined || fromStage === "" ? {} : { fromStage }),
					carryMessages: "before",
					definition,
					cwd: process.cwd(),
				});
				write({ event: "attempt", ok: true, runId: fork.runId });
				break;
			} catch (error) {
				if (!isForkError(error)) {
					write({ event: "attempt", ok: false, untyped: String(error) });
					process.exitCode = 1;
					break;
				}
				write({ event: "attempt", ok: false, name: error.name, code: error.code, retryable: error.retryable });
				if (!error.retryable) break;
				await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 40)));
			}
		}
	}
} finally {
	await backend.close();
}
