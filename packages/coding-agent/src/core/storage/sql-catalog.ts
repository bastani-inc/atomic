import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { withCleanup } from "./cleanup.js";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue } from "./database.js";
import { StoragePayloadTooLargeError } from "./errors.js";

/** A conservative text budget: even four-byte characters and JSON escaping fit below a server's response limit. */
const CATALOG_PAGE_CHARS = 1024 * 1024;
const CATALOG_PAGE_ROWS = 256;

export interface SqlCatalogReadOptions {
	readonly sql: string;
	readonly params?: readonly SqliteValue[];
	readonly key: string;
	readonly size: string;
	readonly signal?: AbortSignal;
	/** Checks the owner's lifetime before and after each request, including after a yielded page. */
	readonly assertOpen?: () => void;
	readonly pageRows?: number;
	/** The caller already began a read transaction on this connection. */
	readonly inSnapshot?: boolean;
	/** A preceding bounded probe already established that a snapshot is needed. */
	readonly skipProbe?: boolean;
}

/** A complete short catalog in one statement, or no data at all: a longer read must start afresh in its snapshot. */
async function readCompleteCatalog<Row extends SqliteRow>(
	db: SqliteExecutor,
	options: SqlCatalogReadOptions,
): Promise<Row[] | undefined> {
	const { sql, key, size, signal, params = [], pageRows = CATALOG_PAGE_ROWS } = options;
	signal?.throwIfAborted();
	try {
		const rows = await db.all<Row & { catalog_complete: number; catalog_count: number }>(
			`WITH candidates AS MATERIALIZED (SELECT * FROM (${sql}) AS catalog LIMIT ?),
			stats AS (SELECT count(*) AS catalog_count, CASE WHEN count(*) < ? AND
				(count(*) <= 1 OR sum(${size}) <= ?) THEN 1 ELSE 0 END AS catalog_complete FROM candidates)
			SELECT candidates.*, stats.* FROM stats LEFT JOIN candidates ON catalog_complete = 1 ORDER BY ${key}`,
			...params,
			pageRows,
			pageRows,
			CATALOG_PAGE_CHARS,
		);
		signal?.throwIfAborted();
		if (Number(rows[0]!.catalog_complete) !== 1) return undefined;
		return Number(rows[0]!.catalog_count) === 0
			? []
			: rows.map(({ catalog_count: _count, catalog_complete: _complete, ...row }) => row as unknown as Row);
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof StoragePayloadTooLargeError && error.kind === "response") return undefined;
		throw error;
	}
}

/**
 * Reads a catalog in unique-key order, bounding both rows examined and text returned on every backend. `sql`, `key`
 * and `size` are trusted SQL; `size` counts the returned row's text. Oversized responses retry the same cursor with
 * fewer rows, never advancing past a row that was not returned. A single oversized row retains the backend's error.
 * Consumers can process each page before the next yield, rather than parse an entire catalog in one event-loop turn.
 */
export async function* readSqlCatalogPages<Row extends SqliteRow>(
	executor: SqliteExecutor,
	options: SqlCatalogReadOptions,
): AsyncIterable<Row[]> {
	const { sql, key, size, signal, params = [] } = options;
	let after: SqliteValue | undefined;
	let limit = options.pageRows ?? CATALOG_PAGE_ROWS;
	for (;;) {
		options.assertOpen?.();
		signal?.throwIfAborted();
		let page: (Row & {
			catalog_chars: number | bigint;
			catalog_row: number | bigint;
			catalog_fetched: number | bigint;
		})[];
		try {
			page = await executor.all<(typeof page)[number]>(
				`SELECT * FROM (
					SELECT page.*, sum(${size}) OVER (ORDER BY ${key}) AS catalog_chars,
						row_number() OVER (ORDER BY ${key}) AS catalog_row, count(*) OVER () AS catalog_fetched
					FROM (SELECT * FROM (${sql}) AS catalog ${after === undefined ? "" : `WHERE ${key} > ?`} ORDER BY ${key} LIMIT ?) AS page
				) AS sized WHERE catalog_chars <= ? OR catalog_row = 1 ORDER BY ${key}`,
				...params,
				...(after === undefined ? [] : [after]),
				limit,
				CATALOG_PAGE_CHARS,
			);
		} catch (error) {
			if (!(error instanceof StoragePayloadTooLargeError) || error.kind !== "response" || limit === 1) throw error;
			limit = Math.max(1, Math.floor(limit / 2));
			await nextTurn();
			continue;
		}
		options.assertOpen?.();
		signal?.throwIfAborted();
		if (page.length === 0) return;
		const last = page.at(-1)!;
		const complete =
			Number(last.catalog_fetched) < limit && Number(last.catalog_row) === Number(last.catalog_fetched);
		after = last[key];
		yield page.map(
			({ catalog_chars: _chars, catalog_row: _row, catalog_fetched: _fetched, ...row }) => row as unknown as Row,
		);
		options.assertOpen?.();
		signal?.throwIfAborted();
		if (complete) return;
		await nextTurn();
	}
}

/** The whole reduction belongs to one read attempt. A retry never retains rows or a cursor from its predecessor. */
export async function reduceSqlCatalog<Row extends SqliteRow, Result>(
	executor: SqliteExecutor,
	options: SqlCatalogReadOptions,
	initial: () => Result,
	append: (value: Result, page: Row[]) => void,
): Promise<{ value: Result; paged: boolean }> {
	const collect = async (tx: SqliteExecutor, source = options) => {
		const value = initial();
		for await (const page of readSqlCatalogPages<Row>(tx, source)) append(value, page);
		return { value, paged: true };
	};
	const db = executor as Partial<SqliteDatabase>;
	if (options.inSnapshot || !db.transaction) return collect(executor);
	options.assertOpen?.();
	const complete = options.skipProbe ? undefined : await readCompleteCatalog<Row>(executor, options);
	options.assertOpen?.();
	options.signal?.throwIfAborted();
	if (complete !== undefined) {
		const value = initial();
		append(value, complete);
		return { value, paged: false };
	}
	await nextTurn();
	options.assertOpen?.();
	options.signal?.throwIfAborted();
	if (db.privateSqliteMemory) {
		// Only this connection can see its database. Copy just the catalog in one statement, then page the
		// indexed temporary copy without occupying the connection between reads. No persistent data changes.
		const table = `catalog_${randomUUID().replaceAll("-", "")}`;
		await executor.run(`CREATE TEMP TABLE ${table} AS ${options.sql}`, ...(options.params ?? []));
		return withCleanup(
			async () => {
				options.assertOpen?.();
				options.signal?.throwIfAborted();
				await executor.exec(`CREATE INDEX ${table}_key ON ${table}(${options.key})`);
				return collect(executor, { ...options, sql: `SELECT * FROM ${table}`, params: [] });
			},
			() => executor.exec(`DROP TABLE temp.${table}`),
		);
	}
	return db.transaction(collect, { readOnly: true, retryTransientFailures: true });
}

/** Collects size-bounded catalog pages without an unbounded argument spread. */
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
