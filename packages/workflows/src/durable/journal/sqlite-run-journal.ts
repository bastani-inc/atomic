import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
	defaultSessionDatabasePath,
	getAgentDir,
	openNodeSqliteDatabase,
	SettingsManager,
	validateStoragePrefix,
	wrapNodeSqliteDatabase,
} from "@bastani/atomic";
import type { StorageHomeSettings } from "@bastani/atomic/storage";
import { SqlRunJournal } from "./sql-run-journal.js";

export { JOURNAL_READ_PAGE_SIZE, SqlRunJournal } from "./sql-run-journal.js";

export function workflowJournalPath(settings?: StorageHomeSettings): string {
	const override = process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
	return override !== undefined && override.length > 0
		? override
		: defaultSessionDatabasePath(getAgentDir(), settings);
}

export async function openSqlRunJournal(
	source?: string | DatabaseSync,
	options: { readonly prefix?: string } = {},
): Promise<SqlRunJournal> {
	validateStoragePrefix(options.prefix);
	if (source === undefined) mkdirSync(getAgentDir(), { recursive: true });
	const selected = source ?? workflowJournalPath(SettingsManager.create(process.cwd(), getAgentDir()).getSettings());
	const database =
		typeof selected === "string" ? await openNodeSqliteDatabase(selected) : wrapNodeSqliteDatabase(selected);
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
