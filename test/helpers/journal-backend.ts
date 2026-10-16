import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import {
	openSqlRunJournal,
	type SqlRunJournal,
} from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { JournalEntry } from "../../packages/workflows/src/durable/journal/types.js";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";

const opened: { readonly backend: JournalTestBackend; readonly dir: string }[] = [];

export class JournalTestBackend extends JournalDurableBackend {
	constructor(
		journal: SqlRunJournal,
		readonly databasePath: string,
	) {
		super(journal);
		opened.push({ backend: this, dir: dirname(databasePath) });
	}

	static async create<T extends typeof JournalTestBackend>(
		this: T,
		path = join(makeTempDirectory("durable-suite-"), "journal.sqlite"),
	): Promise<InstanceType<T>> {
		const journal = await openSqlRunJournal(path);
		const backend = new this(journal, path) as InstanceType<T>;
		const fold = Reflect.get(backend, "fold") as (entry: JournalEntry) => void;
		for (const run of await journal.listRuns()) {
			for await (const entry of journal.read(run.runId)) fold.call(backend, entry);
		}
		return backend;
	}

	async reopen(): Promise<JournalTestBackend> {
		await this.close();
		return JournalTestBackend.create(this.databasePath);
	}
}

afterEach(async () => {
	const entries = opened.splice(0);
	for (const { backend } of entries) await backend.close();
	for (const dir of new Set(entries.map((entry) => entry.dir))) removeTempDirectory(dir);
});
