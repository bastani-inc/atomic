// A workflow root writing its journal to a libSQL server. Once its parent writes "go", it appends a stage completion
// record and a status change per round, so the parent can stop it in the middle of one of those transactions for
// longer than the server keeps an idle stream. Prints one JSON report: every append's outcome, or the typed failure.
import { createInterface } from "node:readline";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { RUN_EVENT_TYPES, type RunEvent } from "../../packages/workflows/src/durable/journal/types.js";

const [url, rounds] = process.argv.slice(2);
const warnings: { name: string; code?: unknown; outcome?: unknown }[] = [];
process.on("warning", (warning: Error & { code?: unknown; outcome?: unknown }) =>
	warnings.push({ name: warning.name, code: warning.code, outcome: warning.outcome }),
);
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();

const database = await openLibsqlDatabase({ url: url! });
const journal = await SqlRunJournal.open(database);
try {
	await journal.createRun({ runId: "root", name: "root", cwd: "/work", createdAt: 0, status: "running" });
	const acquired = await journal.acquire("root", "root-holder");
	if (acquired.status !== "acquired") throw new Error("the root lease is held elsewhere");
	console.log("ready");
	if ((await lines.next()).value !== "go") throw new Error("expected go");
	const outcomes: string[] = [];
	for (let round = 0; round < Number(rounds); round++) {
		const completed = {
			type: RUN_EVENT_TYPES.checkpointRecorded,
			payload: { kind: "stage", stage: `stage-${round}`, status: "completed" },
		} as unknown as RunEvent;
		const status = { type: RUN_EVENT_TYPES.statusChanged, payload: { status: `round-${round}` } } as RunEvent;
		outcomes.push((await journal.append(acquired.lease, completed, { key: `stage:${round}` })).status);
		outcomes.push((await journal.append(acquired.lease, status)).status);
	}
	console.log(JSON.stringify({ outcomes, warnings }));
} catch (error) {
	const { name, code, outcome, message } = error as Error & { code?: unknown; outcome?: unknown };
	console.log(JSON.stringify({ failure: { name, code, outcome, message }, warnings }));
	process.exitCode = 1;
} finally {
	await journal.close();
	await database.close();
	process.stdin.destroy();
}
