import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";

export type JournalTestBackend = JournalDurableBackend & {
	readonly databasePath: string;
	reopen(): Promise<JournalTestBackend>;
};
const opened: { readonly backend: JournalTestBackend; readonly dir: string }[] = [];

export const JournalTestBackend = {
	async create(path = join(makeTempDirectory("durable-suite-"), "journal.sqlite")): Promise<JournalTestBackend> {
		const backend = Object.assign(await JournalDurableBackend.open(await openSqlRunJournal(path)), {
			databasePath: path,
			async reopen(): Promise<JournalTestBackend> {
				await backend.close();
				return JournalTestBackend.create(path);
			},
		});
		opened.push({ backend, dir: dirname(path) });
		return backend;
	},
};

afterEach(async () => {
	const entries = opened.splice(0);
	for (const { backend } of entries) await backend.close();
	for (const dir of new Set(entries.map((entry) => entry.dir))) removeTempDirectory(dir);
});
