import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getAgentDir, openNodeSqliteDatabase, validateStoragePrefix, wrapNodeSqliteDatabase } from "@bastani/atomic";
import { SqlRunJournal } from "./sql-run-journal.js";

export { JOURNAL_READ_PAGE_SIZE, SqlRunJournal } from "./sql-run-journal.js";

export function workflowJournalPath(): string {
	const override = process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
	return override !== undefined && override.length > 0
		? override
		: join(dirname(getAgentDir()), "workflows", "journal.sqlite");
}

export async function openSqlRunJournal(
	source: string | DatabaseSync = workflowJournalPath(),
	options: { readonly prefix?: string } = {},
): Promise<SqlRunJournal> {
	validateStoragePrefix(options.prefix);
	const database = typeof source === "string" ? await openNodeSqliteDatabase(source) : wrapNodeSqliteDatabase(source);
	try {
		const journal = await SqlRunJournal.open(database, options);
		const close = journal.close.bind(journal);
		let closing: Promise<void> | undefined;
		journal.close = () => {
			closing ??= close().then(() => database.close());
			return closing;
		};
		return journal;
	} catch (error) {
		await database.close();
		throw error;
	}
}
