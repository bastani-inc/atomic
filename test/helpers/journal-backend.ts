import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqliteRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";

const opened: { readonly backend: JournalTestBackend; readonly dir: string }[] = [];

export class JournalTestBackend extends JournalDurableBackend {
	constructor(readonly databasePath = join(makeTempDirectory("durable-suite-"), "journal.sqlite")) {
		super(new SqliteRunJournal(databasePath));
		opened.push({ backend: this, dir: dirname(databasePath) });
	}

	async reopen(): Promise<JournalTestBackend> {
		await this.close();
		return new JournalTestBackend(this.databasePath);
	}
}

afterEach(async () => {
	const entries = opened.splice(0);
	for (const { backend } of entries) await backend.close();
	for (const dir of new Set(entries.map((entry) => entry.dir))) removeTempDirectory(dir);
});
