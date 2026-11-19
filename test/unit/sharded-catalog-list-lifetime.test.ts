import { expect, test } from "vitest";
import { ShardedRunJournal } from "../../packages/workflows/src/durable/journal/sharded-run-journal.js";
import type { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

async function createRoots(journal: ShardedRunJournal) {
	for (const runId of ["root-a", "root-b"])
		await journal.createRun({ runId, name: "run", cwd: "/project", createdAt: 1, status: "running" });
}

test("a cancelled shard catalog starts no later shard open after a child read completes (#5537)", async () => {
	const directory = makeTempDirectory("atomic-shard-list-cancel-");
	const controller = new AbortController();
	const reason = new Error("shard list cancelled");
	let reading = false;
	let returned = false;
	let opensAfterAbort = 0;
	const openShard = async (path: string) => {
		if (reading && controller.signal.aborted) opensAfterAbort++;
		const journal = await openSqlRunJournal(path);
		const list = journal.listRuns.bind(journal);
		journal.listRuns = async (...args) => {
			const rows = await list(...args);
			if (reading && !returned) {
				returned = true;
				controller.abort(reason);
			}
			return rows;
		};
		return journal;
	};
	const writer = await ShardedRunJournal.open({ directory, openShard, legacyJournal: false });
	try {
		await createRoots(writer);
	} finally {
		await writer.close();
	}
	const reader = await ShardedRunJournal.open({ directory, openShard, legacyJournal: false });
	try {
		reading = true;
		await expect(reader.listRuns(undefined, { signal: controller.signal })).rejects.toBe(reason);
		expect(returned).toBe(true);
		expect(opensAfterAbort).toBe(0);
	} finally {
		await reader.close();
		removeTempDirectory(directory);
	}
});

test("a cancellable warmed catalog with empty shards yields between shard reads (#5537)", async () => {
	const directory = makeTempDirectory("atomic-shard-list-turns-");
	const handles = new Map<string, SqlRunJournal>();
	let measuring = false;
	let armed = false;
	let turns = 0;
	let timer: ReturnType<typeof setImmediate> | undefined;
	const tick = () => {
		turns++;
		if (measuring) timer = setImmediate(tick);
	};
	const journal = await ShardedRunJournal.open({
		directory,
		legacyJournal: false,
		openShard: async (path) => {
			const child = await openSqlRunJournal(path);
			handles.set(path, child);
			const list = child.listRuns.bind(child);
			child.listRuns = async (...args) => {
				if (measuring && !armed) {
					armed = true;
					timer = setImmediate(tick);
				}
				return list(...args);
			};
			return child;
		},
	});
	try {
		await createRoots(journal);
		for (const child of handles.values()) for (const run of await child.listRuns()) await child.deleteRun(run.runId);
		await journal.listRuns();
		measuring = true;
		expect(await journal.listRuns(undefined, { signal: new AbortController().signal })).toEqual([]);
		expect(armed).toBe(true);
		expect(turns).toBeGreaterThan(0);
	} finally {
		measuring = false;
		if (timer !== undefined) clearImmediate(timer);
		await journal.close();
		removeTempDirectory(directory);
	}
});
