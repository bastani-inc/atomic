import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue } from "./database.js";
import { StoragePayloadTooLargeError } from "./errors.js";

const CATALOG_PAGE_CHARS = 1024 * 1024;
const CATALOG_PAGE_ROWS = 256;

function nextTurn(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof setImmediate === "function") setImmediate(resolve);
		else setTimeout(resolve, 0);
	});
}

export interface SqlCatalogReadOptions {
	readonly sql: string;
	readonly params?: readonly SqliteValue[];
	readonly key: string;
	readonly start?: SqliteValue;
	readonly size: string;
	readonly signal?: AbortSignal;
	readonly assertOpen?: () => void;
	readonly pageRows?: number;
	readonly inSnapshot?: boolean;
	readonly skipProbe?: boolean;
	/** The ordinary query, whose reply is complete unless it reaches its original pacing limit. */
	readonly first?: { readonly sql: string; readonly limit?: number };
	/** Return only the ordinary columns. The continuation key may already be encoded in one of them. */
	readonly columns?: string;
	readonly cursor?: (row: SqliteRow) => SqliteValue;
	/** The original, paced keyset query. Use it unchanged until a server actually refuses its response. */
	readonly pacedPage?: (continued: boolean) => string;
}

function check(options: SqlCatalogReadOptions) {
	options.assertOpen?.();
	options.signal?.throwIfAborted();
}

function responseRefused(error: unknown): boolean {
	return error instanceof StoragePayloadTooLargeError && error.kind === "response";
}

/** A short catalog is complete in one statement. Never mix a discarded first reply with a new snapshot. */
async function readCompleteCatalog<Row extends SqliteRow>(
	db: SqliteExecutor,
	options: SqlCatalogReadOptions,
): Promise<Row[] | undefined> {
	const { sql, key, size, params = [], pageRows = CATALOG_PAGE_ROWS, first } = options;
	try {
		if (first) {
			const rows = await db.all<Row>(
				first.sql,
				...params,
				...(options.start === undefined ? [] : [options.start]),
				...(first.limit === undefined ? [] : [first.limit]),
			);
			return rows.length === first.limit ? undefined : rows;
		}
		// Other catalogs use bounded first batches. Return no rows for an empty catalog, or a single
		// null key for an incomplete one; neither case adds control fields to the data rows.
		const rows = await db.all<Row>(
			`WITH candidates AS MATERIALIZED (SELECT * FROM (${sql}) AS catalog LIMIT ?),
			stats AS (SELECT count(*) AS n, count(*) < ? AND (count(*) <= 1 OR sum(${size}) <= ?) AS complete FROM candidates)
			SELECT candidates.* FROM stats LEFT JOIN candidates ON stats.complete WHERE stats.n > 0 ORDER BY candidates.${key}`,
			...params,
			pageRows,
			pageRows,
			CATALOG_PAGE_CHARS,
		);
		return rows[0]?.[key] === null ? undefined : rows;
	} catch (error) {
		if (!responseRefused(error)) throw error;
		return undefined;
	}
}

/** The cutoff stays in SQL: a one-row response contains no counts, sizes or duplicated cursor. */
export async function* readSqlCatalogPages<Row extends SqliteRow>(
	executor: SqliteExecutor,
	options: SqlCatalogReadOptions,
): AsyncIterable<Row[]> {
	const { sql, key, size, params = [], columns = "*", pageRows = CATALOG_PAGE_ROWS } = options;
	let after = options.start;
	for (;;) {
		check(options);
		const binds = [...params, ...(after === undefined ? [] : [after]), pageRows];
		const page = options.pacedPage
			? await executor.all<Row>(options.pacedPage(after !== undefined), ...binds)
			: await executor.all<Row>(
					`WITH page AS MATERIALIZED (
				SELECT * FROM (${sql}) AS catalog ${after === undefined ? "" : `WHERE ${key} > ?`} ORDER BY ${key} LIMIT ?
			), sized AS (SELECT ${key}, sum(${size}) OVER (ORDER BY ${key}) AS chars FROM page)
			SELECT ${columns} FROM page WHERE ${key} <= coalesce((SELECT max(${key}) FROM sized WHERE chars <= ?), (SELECT min(${key}) FROM page)) ORDER BY ${key}`,
					...binds,
					CATALOG_PAGE_CHARS,
				);
		check(options);
		if (!page.length) return;
		after = options.cursor ? options.cursor(page.at(-1)!) : page.at(-1)![key];
		yield page;
		check(options);
		if (options.pacedPage && page.length < pageRows) return;
		await nextTurn();
	}
}

/** Response refusals can close the server's transaction. Reduce each attempt from scratch on a fresh snapshot. */
export async function reduceSqlCatalog<Row extends SqliteRow, Result>(
	executor: SqliteExecutor,
	options: SqlCatalogReadOptions,
	initial: () => Result,
	append: (value: Result, page: Row[]) => void,
): Promise<{ value: Result; paged: boolean }> {
	let limit = options.pageRows ?? CATALOG_PAGE_ROWS;
	const collect = async (tx: SqliteExecutor) => {
		const value = initial();
		for await (const page of readSqlCatalogPages<Row>(tx, { ...options, pageRows: limit })) append(value, page);
		return { value, paged: true };
	};
	const db = executor as Partial<SqliteDatabase>;
	if (options.inSnapshot || !db.transaction) return collect(executor);
	check(options);
	const complete = options.skipProbe ? undefined : await readCompleteCatalog<Row>(executor, options);
	check(options);
	if (complete !== undefined) {
		const value = initial();
		// Decoding a fitting response is still cancellable, without issuing more SQL.
		for (let i = 0; i < complete.length; i += limit) {
			append(value, complete.length <= limit ? complete : complete.slice(i, i + limit));
			if (i + limit < complete.length) {
				await nextTurn();
				check(options);
			}
		}
		return { value, paged: false };
	}
	for (;;) {
		await nextTurn();
		check(options);
		try {
			return await db.transaction(collect, { readOnly: true, retryTransientFailures: true });
		} catch (error) {
			check(options);
			if (!responseRefused(error) || limit === 1) throw error;
			limit = Math.max(1, Math.floor(limit / 2));
		}
	}
}

export async function readSqlCatalog<Row extends SqliteRow>(
	executor: SqliteExecutor,
	options: SqlCatalogReadOptions,
): Promise<Row[]> {
	return (
		await reduceSqlCatalog<Row, Row[]>(
			executor,
			options,
			() => [],
			(rows, page) => {
				for (const row of page) rows.push(row);
			},
		)
	).value;
}
