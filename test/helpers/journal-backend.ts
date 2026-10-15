import { join } from "node:path";
import { afterEach } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqliteRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";

const opened: { readonly backend: JournalTestBackend; readonly dir: string }[] = [];

export class JournalTestBackend extends JournalDurableBackend {
	constructor() {
		const dir = makeTempDirectory("durable-suite-");
		super(new SqliteRunJournal(join(dir, "journal.sqlite")));
		opened.push({ backend: this, dir });
	}
}

afterEach(async () => {
	for (const { backend, dir } of opened.splice(0)) {
		await backend.close();
		removeTempDirectory(dir);
	}
});
