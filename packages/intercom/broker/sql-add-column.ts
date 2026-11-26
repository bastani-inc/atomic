import { dialectOf, type SqliteDatabase } from "@bastani/atomic/storage";
import { catalogHasColumns } from "./sql-schema.js";

function isLineTerminatorCode(code: number): boolean {
	return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

function matchesAsciiCaseInsensitiveAt(text: string, lowerNeedle: string, offset: number): boolean {
	if (offset < 0 || offset + lowerNeedle.length > text.length) return false;
	for (let i = 0; i < lowerNeedle.length; i++) {
		let code = text.charCodeAt(offset + i);
		if (code >= 0x41 && code <= 0x5a) code += 32;
		if (code !== lowerNeedle.charCodeAt(i)) return false;
	}
	return true;
}

function findAsciiCaseInsensitive(text: string, lowerNeedle: string, fromIndex: number): number {
	const limit = text.length - lowerNeedle.length;
	if (fromIndex > limit) return -1;
	const firstLower = lowerNeedle.charCodeAt(0);
	const isAsciiLetter = firstLower >= 0x61 && firstLower <= 0x7a;
	if (!isAsciiLetter) {
		const firstChar = lowerNeedle[0]!;
		let pos = fromIndex;
		while (pos <= limit) {
			const idx = text.indexOf(firstChar, pos);
			if (idx === -1 || idx > limit) return -1;
			if (matchesAsciiCaseInsensitiveAt(text, lowerNeedle, idx)) return idx;
			pos = idx + 1;
		}
		return -1;
	}
	const firstUpper = firstLower - 32;
	for (let pos = fromIndex; pos <= limit; pos++) {
		const code = text.charCodeAt(pos);
		if ((code === firstLower || code === firstUpper) && matchesAsciiCaseInsensitiveAt(text, lowerNeedle, pos)) {
			return pos;
		}
	}
	return -1;
}

function matchesColumnAlreadyExists(text: string): boolean {
	const firstLower = "column ";
	const secondLower = " already exists";
	let searchFrom = 0;
	let nextSecond = -1;
	let nextSecondLineStart = 0;
	let ltScan = 0;
	while (searchFrom < text.length) {
		const pos = findAsciiCaseInsensitive(text, firstLower, searchFrom);
		if (pos === -1) return false;
		const endFirst = pos + firstLower.length;
		if (nextSecond < endFirst) {
			nextSecond = findAsciiCaseInsensitive(text, secondLower, endFirst);
			if (nextSecond === -1) return false;
			while (ltScan < nextSecond) {
				if (isLineTerminatorCode(text.charCodeAt(ltScan))) {
					nextSecondLineStart = ltScan + 1;
				}
				ltScan++;
			}
		}
		if (endFirst >= nextSecondLineStart) return true;
		searchFrom = nextSecondLineStart;
	}
	return false;
}

/**
 * Whether adding a column failed because it is already there: SQLite's "duplicate column name", Postgres's
 * `column "…" of relation "…" already exists` (SQLSTATE 42701), in the error's message or its cause.
 */
function isDuplicateColumn(error: unknown): boolean {
	const text = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "";
	return /duplicate column/i.test(text) || matchesColumnAlreadyExists(text);
}

/**
 * A statement the database refused for a privilege the role lacks: the PostgreSQL adapter's `missing-privilege`, which
 * the database facade reports as the cause of its `StorageUnavailableError`.
 */
export function isMissingPrivilege(error: unknown): boolean {
	let at = error;
	for (let depth = 0; depth < 4 && typeof at === "object" && at !== null; depth++) {
		if ((at as { reason?: unknown }).reason === "missing-privilege") return true;
		at = (at as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * `addMissingColumns` for one column a store can do without: whether the column is there. A role that may not change
 * tables (a PostgreSQL runtime role with only DML privileges) leaves it out, and the store works as before it existed
 * until `atomic storage migrate`, run as the owner role, adds it. Any other failure is thrown.
 */
export async function addOptionalColumn(
	database: SqliteDatabase,
	table: string,
	column: string,
	definition: string,
	/** Run once with the column's addition, in its transaction, as an index on it. */
	withColumn?: string,
): Promise<boolean> {
	try {
		await addMissingColumns(database, table, { [column]: definition }, withColumn);
		return true;
	} catch (error) {
		if (isMissingPrivilege(error)) return false;
		throw error;
	}
}

/**
 * Adds each missing column of `columns` (name → definition after the name) to `table`, in order. A table from an older
 * broker gets the columns, and an older broker ignores them. Each column is probed and added in a serial transaction,
 * so brokers opening the store at once take turns (#5054); an older broker adding one meanwhile is not an error.
 */
export async function addMissingColumns(
	database: SqliteDatabase,
	table: string,
	columns: Readonly<Record<string, string>>,
	withColumn?: string,
): Promise<void> {
	const dialect = dialectOf(database);
	// An open that read the catalog and found every column there runs no transaction (#6560).
	if (await catalogHasColumns(database, table, Object.keys(columns))) return;
	for (const [column, definition] of Object.entries(columns)) {
		const probe = dialect.columnExists(table, column);
		try {
			await database.transaction(async (tx) => {
				if ((await tx.all(probe.sql, ...probe.params)).length > 0) return;
				await tx.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
				if (withColumn !== undefined) await tx.exec(withColumn);
			});
		} catch (error) {
			if (!isDuplicateColumn(error)) throw error;
		}
	}
}
