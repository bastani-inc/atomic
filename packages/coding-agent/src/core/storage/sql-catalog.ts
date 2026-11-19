import { setImmediate as nextTurn } from "node:timers/promises";
import type { SqliteExecutor, SqliteRow, SqliteValue } from "./database.js";
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

/** Collects size-bounded catalog pages without an unbounded argument spread. */
export async function readSqlCatalog<Row extends SqliteRow>(
	executor: SqliteExecutor,
	options: SqlCatalogReadOptions,
): Promise<Row[]> {
	const rows: Row[] = [];
	for await (const page of readSqlCatalogPages<Row>(executor, options)) {
		for (const row of page) rows.push(row);
	}
	return rows;
}
